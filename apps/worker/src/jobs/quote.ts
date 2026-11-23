import {
  checkOfferAccepted,
  detectQuoteRequest,
  draftOrderReply,
  draftQuoteReply,
  matchItems,
  type RequestedItem,
} from "@adminwise/ai";
import { addDays, localClock } from "@adminwise/core";
import {
  canFile,
  forCustomer,
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
  unitMeansOne,
} from "@adminwise/offers";
import { allowed, describeError, type Deps } from "../deps";
import { safeName } from "./filing";
import { appendSignature } from "./signature";


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
  /** "offer" = an offer PDF is attached; "clarify" = the draft only asks questions; "order" = an order confirmation is attached. */
  outcome: "offer" | "clarify" | "order";
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
 * Makes the order confirmation for an accepted offer: the same lines and
 * prices as the offer, under the offer's number with "-C", marked as not being
 * an invoice. `messageId` is the message it answers (the customer's acceptance,
 * or the original request when the owner confirmed it themselves); asking twice
 * for the same message gives the same document.
 */
export async function makeOrderConfirmation(
  deps: Deps,
  scope: CustomerScope,
  input: { customer: Customer; offer: Offer; message: Message; connection: MailboxConnection | null },
): Promise<{ confirmation: Offer; attachment: OutboundAttachment }> {
  const { customer, offer, message } = input;
  const now = deps.now?.() ?? new Date();
  let confirmation = await scope.getOfferForMessage("order_confirmation", message.id);
  if (!confirmation) {
    const id = await scope.createOffer({
      kind: "order_confirmation",
      number: `${offer.number}-C`,
      threadId: offer.threadId,
      messageId: message.id,
      sourceOfferId: offer.id,
      priceListId: offer.priceListId,
      recipientDomain: offer.recipientDomain,
      language: offer.language,
      layout: offer.layout,
      currency: offer.currency,
      vatRate: offer.vatRate,
      discountPercent: offer.discountPercent,
      netCents: offer.netCents,
      discountCents: offer.discountCents,
      vatCents: offer.vatCents,
      grossCents: offer.grossCents,
      validUntil: null,
      lines: offer.lines,
      createdAt: now,
    });
    confirmation = id ? await scope.getOffer(id) : await scope.getOfferForMessage("order_confirmation", message.id);
    if (!confirmation) throw new Error("Order confirmation could not be stored");
  }
  await scope.markOfferAccepted(offer.id);

  const date = localClock(confirmation.createdAt, customer.timeZone).date;
  const document = await offerDocument(scope, customer, confirmation, {
    date,
    recipient: [message.direction === "inbound" && message.fromAddress ? message.fromAddress : offer.recipientDomain],
    sourceOfferNumber: offer.number,
  });
  const pdf = await deps.pdf.render(renderOfferHtml(document));
  const fileName = offerFileName(confirmation);
  if (!confirmation.storedPath) {
    await fileOfferCopy(deps, scope, input.connection, confirmation.id, date.slice(0, 4), fileName, pdf);
  }
  return { confirmation, attachment: { name: fileName, contentType: "application/pdf", content: pdf } };
}

/**
 * The acceptance part of the reply-draft job: when the conversation has an
 * open offer and the sender's message accepts it ("please go ahead"), the
 * draft carries an order confirmation. Returns null when there is no open
 * offer or the message is anything other than a clear acceptance.
 */
export async function prepareOrderConfirmation(
  deps: Deps,
  scope: CustomerScope,
  input: { customer: Customer; message: Message; connection: MailboxConnection | null; language: string },
): Promise<QuoteReply | null> {
  const { customer, message } = input;
  if (message.bodyText === null) return null;
  const offer = await scope.latestOpenOfferForThread(message.threadId);
  if (!offer) return null;

  const check = await checkOfferAccepted(deps.ai, {
    companyName: customer.name,
    offerNumber: offer.number,
    subject: message.subject,
    body: message.bodyText,
  });
  if (!check.accepted) {
    // The tokens of the check are small and are not carried into the ordinary reply's count.
    return null;
  }
  const { confirmation, attachment } = await makeOrderConfirmation(deps, scope, { ...input, offer });
  const reply = await draftOrderReply(deps.ai, {
    companyName: customer.name,
    voiceProfile: customer.voiceProfile,
    language: input.language,
    confirmationNumber: confirmation.number,
    offerNumber: offer.number,
    latest: { senderDomain: message.senderDomain, subject: message.subject, body: message.bodyText },
  });
  return {
    body: reply.body,
    attachments: [attachment],
    outcome: "order",
    inputTokens: check.usage.inputTokens + reply.usage.inputTokens,
    outputTokens: check.usage.outputTokens + reply.usage.outputTokens,
  };
}

/**
 * The owner clicked "prepare the order confirmation" in the daily brief: the
 * customer accepted by phone or in another mail. Makes the confirmation and
 * puts a draft with it on the original request (Outlook), or emails it to the
 * owner (forwarding address). Nothing is sent to the customer's contact.
 */
export async function confirmOffer(deps: Deps, job: { customerId: string; offerId: string }): Promise<"confirmed" | "skipped"> {
  const scope = forCustomer(deps.db, job.customerId);
  const runId = await scope.startJobRun("order-confirmation", job.offerId);
  const skip = async (outcome: string) => {
    await scope.finishJobRun(runId, { status: "skipped", outcome });
    return "skipped" as const;
  };
  try {
    const offer = await scope.getOffer(job.offerId);
    if (!offer || offer.kind !== "offer" || !offer.messageId) return await skip("no_offer");
    if (offer.status === "accepted") return await skip("already_confirmed");
    const message = await scope.getMessage(offer.messageId);
    if (!message) return await skip("no_offer");
    const [customer, connection] = await Promise.all([
      scope.getCustomer(),
      message.connectionId ? scope.getConnection(message.connectionId) : null,
    ]);
    // Order confirmations belong to the Run plan.
    if (!allowed(deps, customer).offers) return await skip("not_in_plan");
    const toOutlook = connection?.provider === "microsoft";
    const language = message.language ?? customer.languages[0] ?? "en";

    const draftId = await scope.claimDraft({
      messageId: message.id,
      threadId: message.threadId,
      destination: toOutlook ? "outlook_drafts" : "email_to_customer",
      language,
      languageListed: customer.languages.includes(language),
      kind: "order_confirmation",
    });
    if (!draftId) return await skip("already_confirmed");

    try {
      const { confirmation, attachment } = await makeOrderConfirmation(deps, scope, { customer, offer, message, connection });
      const reply = await draftOrderReply(deps.ai, {
        companyName: customer.name,
        voiceProfile: customer.voiceProfile,
        language,
        confirmationNumber: confirmation.number,
        offerNumber: offer.number,
        latest: null,
      });
      const text = appendSignature(reply.body, customer.signatureText);
      let providerDraftId: string | null = null;
      if (toOutlook) {
        providerDraftId = await deps.outlook.createReplyDraft(scope, connection!.id, message.providerMessageId, text, [attachment]);
      } else {
        const users = await scope.listUsers();
        await deps.mailer.send({
          to: users.map((u) => u.email),
          subject: `Order confirmation ${confirmation.number}: ${message.subject}`,
          textBody:
            `${deps.appName} prepared order confirmation ${confirmation.number} for ${offer.recipientDomain}. ` +
            "It is attached. Nothing was sent: review the text below and send it with the attachment yourself.\n\n" +
            `--------------------\n\n${text}\n`,
          attachments: [attachment],
        });
      }
      await scope.completeDraft(draftId, text, providerDraftId, deps.now?.() ?? null);
      await scope.finishJobRun(runId, {
        status: "succeeded",
        inputTokens: reply.usage.inputTokens,
        outputTokens: reply.usage.outputTokens,
        outcome: `order:${toOutlook ? "outlook" : "email"}`,
      });
      return "confirmed";
    } catch (error) {
      await scope.failDraft(draftId, describeError(error));
      throw error;
    }
  } catch (error) {
    await scope.finishJobRun(runId, { status: "failed", error: describeError(error) });
    throw error;
  }
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
    // A monthly package or a whole project is ordered once; for anything counted (pieces, hours, people) we ask.
    if (requested.quantity !== null) priced.push({ item, quantity: requested.quantity });
    else if (unitMeansOne(item.unit)) priced.push({ item, quantity: 1 });
    else unclear.push({ request: requested.request, reason: "no_quantity", options: [item.name] });
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
