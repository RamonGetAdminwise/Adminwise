import { detectQuoteRequest, draftQuoteReply, matchItems, type RequestedItem } from "@adminwise/ai";
import { addDays, localClock } from "@adminwise/core";
import {
  canFile,
  type Customer,
  type CustomerScope,
  type MailboxConnection,
  type Message,
  type Offer,
  type PriceListItem,
} from "@adminwise/db";
import { GraphError, type OutboundAttachment } from "@adminwise/mail";
import {
  buildOffer,
  formatOfferNumber,
  formatQuantity,
  matchByCode,
  offerStrings,
  rankCandidates,
  renderOfferHtml,
  type OfferDocument,
} from "@adminwise/offers";
import type { Deps } from "../deps";
import { safeName } from "./filing";

/** How many price list items the model is shown per requested item. */
const CANDIDATES_PER_ITEM = 10;

export interface Unclear {
  request: string;
  reason: "not_found" | "ambiguous" | "no_quantity";
  options: string[];
}

export interface QuoteReply {
  /** The reply text, without signature. */
  body: string;
  /** The offer PDF, or nothing when no item could be priced. */
  attachments: OutboundAttachment[];
  /** "offer" = a PDF is attached; "clarify" = the draft only asks questions. */
  outcome: "offer" | "clarify";
  inputTokens: number;
  outputTokens: number;
}

/** The offer or order confirmation as a document, from what is stored. Nothing is recalculated. */
export async function offerDocument(
  scope: CustomerScope,
  customer: Customer,
  offer: Pick<Offer, "kind" | "number" | "language" | "layout" | "currency" | "validUntil" | "lines" | "netCents" | "discountPercent" | "discountCents" | "vatRate" | "vatCents" | "grossCents">,
  extra: { date: string; recipient: string[]; sourceOfferNumber?: string | null },
): Promise<OfferDocument> {
  const logo = await scope.getLogo();
  return {
    kind: offer.kind,
    number: offer.number,
    date: extra.date,
    validUntil: offer.validUntil,
    sourceOfferNumber: extra.sourceOfferNumber ?? null,
    language: offer.language,
    layout: offer.layout,
    brandColor: customer.brandColor,
    logoDataUrl: logo ? `data:${logo.contentType};base64,${Buffer.from(logo.content).toString("base64")}` : null,
    companyName: customer.name,
    companyDetails: customer.companyDetails,
    recipient: extra.recipient,
    currency: offer.currency,
    lines: offer.lines,
    totals: {
      netCents: offer.netCents,
      discountPercent: offer.discountPercent,
      discountCents: offer.discountCents,
      netAfterDiscountCents: offer.netCents - offer.discountCents,
      vatRate: offer.vatRate,
      vatCents: offer.vatCents,
      grossCents: offer.grossCents,
    },
    paymentTerms: customer.paymentTerms,
    bankDetails: customer.bankDetails,
    footer: customer.offerFooter,
  };
}

/** "Oferta_OF-2026-007.pdf": the document's name in the offer language, safe as a file name. */
export function offerFileName(offer: Pick<Offer, "kind" | "number" | "language">): string {
  const t = offerStrings(offer.language);
  const title = (offer.kind === "offer" ? t.offer : t.orderConfirmation).replace(/\s+/g, "_");
  return `${title}_${safeName(offer.number, "document").replace(/[_\s]+/g, "-")}.pdf`;
}

/**
 * Keeps a copy of a document we made in the customer's OneDrive app folder,
 * under Offers/<year>/. Needs a connected Microsoft 365 account with filing
 * switched on; otherwise there is simply no copy. A failure here never stops
 * the draft: the record of the offer is in our database either way.
 */
export async function fileOfferCopy(
  deps: Deps,
  scope: CustomerScope,
  connection: MailboxConnection | null,
  offerId: string,
  year: string,
  fileName: string,
  pdf: Uint8Array,
): Promise<string | null> {
  if (!connection || connection.status !== "active" || !canFile(connection)) return null;
  const dot = fileName.lastIndexOf(".");
  for (let attempt = 1; attempt <= 20; attempt++) {
    const name = attempt === 1 ? fileName : `${fileName.slice(0, dot)} (${attempt})${fileName.slice(dot)}`;
    const path = `Offers/${year}/${name}`;
    try {
      await deps.outlook.uploadFile(scope, connection.id, path, pdf, "application/pdf");
      await scope.setOfferStoredPath(offerId, path);
      return path;
    } catch (error) {
      if (error instanceof GraphError && error.status === 409) continue;
      return null;
    }
  }
  return null;
}

/**
 * The quote part of the reply-draft job. For a business mail of a customer who
 * has a confirmed price list:
 *
 *   1. Ask the model whether the mail asks for a quote and what for. It only
 *      reports the sender's words and stated quantities.
 *   2. Match each requested item to the price list: by item code first (no
 *      model); otherwise the model picks from a short list of candidates, or
 *      says "ambiguous" or "none".
 *   3. Price what is clear, by code: quantity from the request, price from the
 *      price list, discount rule for the sender, VAT. Make the PDF.
 *   4. Write the reply: it announces the attached offer and asks about every
 *      item that was not clear. No price ever appears in the email text.
 *
 * Returns null when the mail is not a quote request or there is no price list;
 * the caller then writes an ordinary reply.
 */
export async function prepareQuoteReply(
  deps: Deps,
  scope: CustomerScope,
  input: { customer: Customer; message: Message; connection: MailboxConnection | null; language: string },
): Promise<QuoteReply | null> {
  const { customer, message } = input;
  const priceList = await scope.getPriceListByStatus("active");
  if (!priceList || message.bodyText === null) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  const spent = (usage: { inputTokens: number; outputTokens: number }) => {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  };

  // 1. Is it a quote request, and for what?
  const detected = await detectQuoteRequest(deps.ai, { companyName: customer.name, subject: message.subject, body: message.bodyText });
  spent(detected.usage);
  if (!detected.isQuoteRequest) return null;

  // 2. Which price list items are meant?
  const items = await scope.listPriceItems(priceList.id);
  const found = new Map<number, PriceListItem>();
  const unclear: Unclear[] = [];
  const forModel: { index: number; requested: RequestedItem; candidates: PriceListItem[] }[] = [];
  detected.items.forEach((requested, index) => {
    const byCode = matchByCode(requested.request, items);
    if (byCode === "ambiguous") {
      unclear.push({ request: requested.request, reason: "ambiguous", options: [] });
    } else if (byCode) {
      found.set(index, byCode);
    } else {
      const candidates = rankCandidates(requested.request, items, CANDIDATES_PER_ITEM);
      if (candidates.length === 0) unclear.push({ request: requested.request, reason: "not_found", options: [] });
      else forModel.push({ index, requested, candidates });
    }
  });
  if (forModel.length > 0) {
    const answer = await matchItems(deps.ai, {
      items: forModel.map((m) => ({
        request: m.requested.request,
        candidates: m.candidates.map((c) => ({ code: c.code, name: c.name, aliases: c.aliases, unit: c.unit })),
      })),
    });
    spent(answer.usage);
    answer.matches.forEach((match, i) => {
      const { index, requested, candidates } = forModel[i]!;
      if (match.result === "match") found.set(index, candidates[match.candidate - 1]!);
      else if (match.result === "ambiguous") {
        unclear.push({ request: requested.request, reason: "ambiguous", options: candidates.slice(0, 5).map((c) => c.name) });
      } else unclear.push({ request: requested.request, reason: "not_found", options: [] });
    });
  }

  // 3. Price what is clear. A quantity the sender did not state is asked for, never assumed.
  const priced: { item: PriceListItem; quantity: number }[] = [];
  detected.items.forEach((requested, index) => {
    const item = found.get(index);
    if (!item) return;
    if (requested.quantity === null) unclear.push({ request: requested.request, reason: "no_quantity", options: [item.name] });
    else priced.push({ item, quantity: requested.quantity });
  });

  const now = deps.now?.() ?? new Date();
  const today = localClock(now, customer.timeZone).date;
  const attachments: OutboundAttachment[] = [];
  let offer: Offer | null = await scope.getOfferForMessage("offer", message.id);

  if (!offer && priced.length > 0) {
    const discountPercent = await scope.discountFor(message.fromAddress, message.senderDomain);
    const { lines, totals } = buildOffer(priced, { discountPercent, vatRate: customer.vatRate });
    const { counter, pattern } = await scope.nextOfferCounter(Number(today.slice(0, 4)));
    const offerId = await scope.createOffer({
      kind: "offer",
      number: formatOfferNumber(pattern, Number(today.slice(0, 4)), counter),
      threadId: message.threadId,
      messageId: message.id,
      sourceOfferId: null,
      priceListId: priceList.id,
      recipientDomain: message.senderDomain,
      language: customer.offerLanguage,
      layout: customer.offerLayout,
      currency: priceList.currency,
      vatRate: totals.vatRate,
      discountPercent: totals.discountPercent,
      netCents: totals.netCents,
      discountCents: totals.discountCents,
      vatCents: totals.vatCents,
      grossCents: totals.grossCents,
      validUntil: addDays(today, customer.offerValidDays),
      lines,
      createdAt: now,
    });
    // Null = another run made the offer for this mail a moment ago: use that one.
    offer = offerId ? await scope.getOffer(offerId) : await scope.getOfferForMessage("offer", message.id);
  }

  if (offer) {
    const document = await offerDocument(scope, customer, offer, {
      date: localClock(offer.createdAt, customer.timeZone).date,
      recipient: [message.fromAddress ?? message.senderDomain],
    });
    const pdf = await deps.pdf.render(renderOfferHtml(document));
    const fileName = offerFileName(offer);
    attachments.push({ name: fileName, contentType: "application/pdf", content: pdf });
    if (!offer.storedPath) await fileOfferCopy(deps, scope, input.connection, offer.id, today.slice(0, 4), fileName, pdf);
  }

  // 4. The email that goes with it.
  const reply = await draftQuoteReply(deps.ai, {
    companyName: customer.name,
    voiceProfile: customer.voiceProfile,
    language: input.language,
    offer: offer
      ? {
          number: offer.number,
          validUntil: offer.validUntil ?? "",
          items: offer.lines.map((l) => ({ name: l.name, quantity: formatQuantity(l.quantity, "en"), unit: l.unit })),
        }
      : null,
    unclear,
    latest: { senderDomain: message.senderDomain, subject: message.subject, body: message.bodyText },
  });
  spent(reply.usage);

  return { body: reply.body, attachments, outcome: offer ? "offer" : "clarify", inputTokens, outputTokens };
}
