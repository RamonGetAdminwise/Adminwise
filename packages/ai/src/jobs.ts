import { chaserCheckPrompt, type ChaserCheckInput } from "../prompts/chaser-check";
import { chaserDraftPrompt, type ChaserDraftInput } from "../prompts/chaser-draft";
import { classifyPrompt, type ClassifyInput } from "../prompts/classify";
import { fileTypePrompt, type FileTypeInput } from "../prompts/file-type";
import { invoiceFieldsPrompt, type InvoiceFieldsInput } from "../prompts/invoice-fields";
import { matchItemsPrompt, type MatchItemsInput } from "../prompts/match-items";
import { paymentNoticePrompt, type PaymentNoticeInput } from "../prompts/payment-notice";
import { paymentReminderPrompt, type PaymentReminderInput } from "../prompts/payment-reminder";
import { offerDetailsPrompt, type OfferDetailsInput } from "../prompts/offer-details";
import { offerAcceptancePrompt, type OfferAcceptanceInput } from "../prompts/offer-acceptance";
import { orderReplyPrompt, type OrderReplyInput } from "../prompts/order-reply";
import { priceListColumnsPrompt, type PriceListColumnsInput } from "../prompts/price-list-columns";
import { quoteReplyPrompt, type QuoteReplyInput } from "../prompts/quote-reply";
import { quoteRequestPrompt, type QuoteRequestInput } from "../prompts/quote-request";
import { replyDraftPrompt, type ReplyDraftInput } from "../prompts/reply-draft";
import { voiceProfilePrompt, type VoiceProfileInput } from "../prompts/voice-profile";
import { AiError, type AiClient, type AiUsage } from "./client";
import { clip, stripQuotedHistory } from "./text";

export const CATEGORIES = ["business", "newsletter", "notification", "auto_reply", "internal"] as const;
export type Category = (typeof CATEGORIES)[number];

const MAX_BODY_CHARS = 12_000;
const MAX_HISTORY_CHARS = 3_000;

export async function classifyMessage(
  ai: AiClient,
  input: ClassifyInput,
): Promise<{ category: Category; language: string; usage: AiUsage }> {
  const prompt = classifyPrompt({ ...input, body: clip(input.body, MAX_BODY_CHARS) });
  const result = await ai.complete({ job: "classify", ...prompt, maxTokens: 2000 });
  const json = /\{[^{}]*\}/.exec(result.text)?.[0];
  let parsed: { category?: unknown; language?: unknown } = {};
  try {
    parsed = json ? (JSON.parse(json) as typeof parsed) : {};
  } catch {
    // handled below
  }
  const category = CATEGORIES.find((c) => c === parsed.category);
  const language = typeof parsed.language === "string" ? parsed.language.trim().toLowerCase().slice(0, 2) : "";
  if (!category || !/^[a-z]{2}$/.test(language)) {
    throw new AiError("Classification answer was not in the expected format");
  }
  return { category, language, usage: result };
}

export async function draftReply(
  ai: AiClient,
  input: ReplyDraftInput,
): Promise<{ body: string; usage: AiUsage }> {
  const prompt = replyDraftPrompt({
    ...input,
    // Only what the sender wrote this time; the quoted thread below it is dropped.
    latest: { ...input.latest, body: clip(stripQuotedHistory(input.latest.body), MAX_BODY_CHARS) },
    history: input.history.map((m) => ({ ...m, body: clip(stripQuotedHistory(m.body), MAX_HISTORY_CHARS) })),
  });
  const result = await ai.complete({ job: "reply-draft", ...prompt, maxTokens: 6000 });
  const body = result.text.trim();
  if (!body) throw new AiError("Model returned an empty draft");
  return { body, usage: result };
}

function firstJson(text: string): Record<string, unknown> {
  const json = /\{[^{}]*\}/.exec(text)?.[0];
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Does the company's own last message expect an answer? Anything but a clear "yes" is no. */
export async function checkExpectsReply(
  ai: AiClient,
  input: ChaserCheckInput,
): Promise<{ expectsReply: boolean; usage: AiUsage }> {
  const prompt = chaserCheckPrompt({ ...input, body: clip(stripQuotedHistory(input.body), MAX_BODY_CHARS) });
  const result = await ai.complete({ job: "chaser-check", ...prompt, maxTokens: 2000 });
  const answer = firstJson(result.text).expects_reply;
  if (answer !== "yes" && answer !== "no") throw new AiError("Follow-up check answer was not in the expected format");
  return { expectsReply: answer === "yes", usage: result };
}

export async function draftChaser(ai: AiClient, input: ChaserDraftInput): Promise<{ body: string; usage: AiUsage }> {
  const prompt = chaserDraftPrompt({ ...input, body: clip(stripQuotedHistory(input.body), MAX_BODY_CHARS) });
  const result = await ai.complete({ job: "chaser-draft", ...prompt, maxTokens: 4000 });
  const body = result.text.trim();
  if (!body) throw new AiError("Model returned an empty follow-up");
  return { body, usage: result };
}

export const DOCUMENT_TYPES = ["invoice", "order", "contract", "offer", "other"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** What kind of document an attachment is, from its name and the email around it. Unclear = "other". */
export async function classifyDocument(
  ai: AiClient,
  input: FileTypeInput,
): Promise<{ type: DocumentType; usage: AiUsage }> {
  const prompt = fileTypePrompt({ ...input, body: clip(stripQuotedHistory(input.body), MAX_HISTORY_CHARS) });
  const result = await ai.complete({ job: "file-type", ...prompt, maxTokens: 2000 });
  const type = DOCUMENT_TYPES.find((t) => t === firstJson(result.text).type);
  if (!type) throw new AiError("Document type answer was not in the expected format");
  return { type, usage: result };
}

/** The outermost JSON object in a model answer (for answers that hold lists). */
function outerJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface RequestedItem {
  /** The sender's own words for the item. */
  request: string;
  /** Null when the sender stated none: a quantity is never assumed. */
  quantity: number | null;
  unit: string | null;
}
const MAX_QUOTE_ITEMS = 30;

/**
 * Does the email ask for a quote, and for what? Quantities are checked against
 * the email text: a number the model reports but the sender did not write is
 * dropped, so the sender is asked instead.
 */
export async function detectQuoteRequest(
  ai: AiClient,
  input: QuoteRequestInput,
): Promise<{ isQuoteRequest: boolean; items: RequestedItem[]; usage: AiUsage }> {
  const body = clip(stripQuotedHistory(input.body), MAX_BODY_CHARS);
  const result = await ai.complete({ job: "quote-request", ...quoteRequestPrompt({ ...input, body }), maxTokens: 4000 });
  const answer = outerJson(result.text);
  if ((answer.is_quote_request !== "yes" && answer.is_quote_request !== "no") || !Array.isArray(answer.items)) {
    throw new AiError("Quote request answer was not in the expected format");
  }
  const written = `${input.subject}\n${body}`;
  const items: RequestedItem[] = [];
  for (const raw of answer.items.slice(0, MAX_QUOTE_ITEMS) as Record<string, unknown>[]) {
    const request = typeof raw?.request === "string" ? raw.request.trim().slice(0, 200) : "";
    if (!request) continue;
    let quantity = typeof raw.quantity === "number" && Number.isFinite(raw.quantity) && raw.quantity > 0 && raw.quantity <= 1_000_000 ? raw.quantity : null;
    if (quantity !== null) {
      // The sender wrote the number as digits ("12", "2,5"), or it is small enough to have been a word ("two").
      const digits = String(quantity).replace(".", "[.,]");
      const stated = new RegExp(`(^|[^0-9.,])${digits}([^0-9]|$)`).test(written);
      if (!stated && !(Number.isInteger(quantity) && quantity <= 12)) quantity = null;
    }
    items.push({ request, quantity, unit: typeof raw.unit === "string" && raw.unit.trim() ? raw.unit.trim().slice(0, 20) : null });
  }
  return { isQuoteRequest: answer.is_quote_request === "yes" && items.length > 0, items, usage: result };
}

export type ItemMatch = { result: "match"; candidate: number } | { result: "ambiguous" | "none"; candidate: null };

/**
 * Which candidate each requested item is. The answer is checked: a candidate
 * number that is not on that item's list counts as "none", and a missing answer
 * as "ambiguous" (the sender is asked).
 */
export async function matchItems(ai: AiClient, input: MatchItemsInput): Promise<{ matches: ItemMatch[]; usage: AiUsage }> {
  const result = await ai.complete({ job: "match-items", ...matchItemsPrompt(input), maxTokens: 4000 });
  const answer = outerJson(result.text);
  if (!Array.isArray(answer.matches)) throw new AiError("Item matching answer was not in the expected format");
  const byItem = new Map<number, Record<string, unknown>>();
  for (const entry of answer.matches as Record<string, unknown>[]) {
    if (typeof entry?.item === "number") byItem.set(entry.item, entry);
  }
  const matches = input.items.map((item, index): ItemMatch => {
    const entry = byItem.get(index + 1);
    if (!entry) return { result: "ambiguous", candidate: null };
    if (entry.result === "match") {
      const candidate = entry.candidate;
      const valid = typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1 && candidate <= item.candidates.length;
      return valid ? { result: "match", candidate: candidate as number } : { result: "none", candidate: null };
    }
    return { result: entry.result === "none" ? "none" : "ambiguous", candidate: null };
  });
  return { matches, usage: result };
}

export async function draftQuoteReply(ai: AiClient, input: QuoteReplyInput): Promise<{ body: string; usage: AiUsage }> {
  const prompt = quoteReplyPrompt({
    ...input,
    latest: { ...input.latest, body: clip(stripQuotedHistory(input.latest.body), MAX_BODY_CHARS) },
  });
  const result = await ai.complete({ job: "quote-reply", ...prompt, maxTokens: 6000 });
  const body = result.text.trim();
  if (!body) throw new AiError("Model returned an empty draft");
  return { body, usage: result };
}

/** Does this reply accept the offer sent earlier in the conversation? Anything but a clear "yes" is no. */
export async function checkOfferAccepted(
  ai: AiClient,
  input: OfferAcceptanceInput,
): Promise<{ accepted: boolean; usage: AiUsage }> {
  const prompt = offerAcceptancePrompt({ ...input, body: clip(stripQuotedHistory(input.body), MAX_BODY_CHARS) });
  const result = await ai.complete({ job: "offer-acceptance", ...prompt, maxTokens: 2000 });
  const answer = firstJson(result.text).accepts;
  if (answer !== "yes" && answer !== "no") throw new AiError("Offer acceptance answer was not in the expected format");
  return { accepted: answer === "yes", usage: result };
}

export async function draftOrderReply(ai: AiClient, input: OrderReplyInput): Promise<{ body: string; usage: AiUsage }> {
  const prompt = orderReplyPrompt({
    ...input,
    latest: input.latest ? { ...input.latest, body: clip(stripQuotedHistory(input.latest.body), MAX_BODY_CHARS) } : null,
  });
  const result = await ai.complete({ job: "order-reply", ...prompt, maxTokens: 4000 });
  const body = result.text.trim();
  if (!body) throw new AiError("Model returned an empty draft");
  return { body, usage: result };
}

export interface InvoiceReading {
  isInvoice: boolean;
  issuedByCompany: boolean;
  /** Proposals only: the caller keeps a value only when it is printed in the document. */
  number: string | null;
  grossAmount: string | null;
  currency: string | null;
  issueDate: string | null;
  dueDate: string | null;
  paymentTermDays: number | null;
  buyer: string | null;
  language: string | null;
}

/** Reads the key fields of a document that may be one of the company's own invoices. */
export async function readInvoiceFields(
  ai: AiClient,
  input: InvoiceFieldsInput,
): Promise<{ reading: InvoiceReading; usage: AiUsage }> {
  const result = await ai.complete({
    job: "invoice-fields",
    ...invoiceFieldsPrompt({ ...input, text: clip(input.text, MAX_BODY_CHARS) }),
    maxTokens: 2000,
  });
  const answer = firstJson(result.text);
  if (answer.is_invoice !== "yes" && answer.is_invoice !== "no") {
    throw new AiError("Invoice reading answer was not in the expected format");
  }
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null);
  const amount = typeof answer.gross_amount === "number" ? String(answer.gross_amount) : text(answer.gross_amount);
  const language = text(answer.language)?.toLowerCase().slice(0, 2) ?? null;
  return {
    reading: {
      isInvoice: answer.is_invoice === "yes",
      issuedByCompany: answer.issued_by_company === "yes",
      number: text(answer.number),
      grossAmount: amount,
      currency: text(answer.currency),
      issueDate: text(answer.issue_date),
      dueDate: text(answer.due_date),
      paymentTermDays: typeof answer.payment_term_days === "number" ? answer.payment_term_days : null,
      buyer: text(answer.buyer),
      language: language && /^[a-z]{2}$/.test(language) ? language : null,
    },
    usage: result,
  };
}

/** What the model found on a sample offer or invoice. Unchecked: the caller keeps only what is printed in the text. */
export interface OfferDetailsReading {
  companyLines: string[];
  bankLines: string[];
  paymentTerms: string | null;
  currency: string | null;
  vatRate: number | null;
  language: string | null;
}

/** Reads the company's own standing details from the text of one of its past offers or invoices. */
export async function readOfferDetails(
  ai: AiClient,
  input: OfferDetailsInput,
): Promise<{ reading: OfferDetailsReading; usage: AiUsage }> {
  const result = await ai.complete({
    job: "offer-details",
    ...offerDetailsPrompt({ ...input, text: clip(input.text, MAX_BODY_CHARS) }),
    maxTokens: 2000,
  });
  const answer = firstJson(result.text);
  if (!Array.isArray(answer.company_lines)) throw new AiError("Offer details answer was not in the expected format");
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const lines = (value: unknown, max: number) =>
    (Array.isArray(value) ? value : [])
      .map((line) => text(line, 200))
      .filter((line): line is string => line !== null)
      .slice(0, max);
  const language = text(answer.language, 2)?.toLowerCase() ?? null;
  return {
    reading: {
      companyLines: lines(answer.company_lines, 8),
      bankLines: lines(answer.bank_lines, 5),
      paymentTerms: text(answer.payment_terms, 300),
      currency: text(answer.currency, 3)?.toUpperCase() ?? null,
      vatRate: typeof answer.vat_rate === "number" && Number.isFinite(answer.vat_rate) ? answer.vat_rate : null,
      language: language && /^[a-z]{2}$/.test(language) ? language : null,
    },
    usage: result,
  };
}

export async function draftPaymentReminder(
  ai: AiClient,
  input: PaymentReminderInput,
): Promise<{ body: string; usage: AiUsage }> {
  const result = await ai.complete({ job: "payment-reminder", ...paymentReminderPrompt(input), maxTokens: 4000 });
  const body = result.text.trim();
  if (!body) throw new AiError("Model returned an empty reminder");
  return { body, usage: result };
}

/** Does this reply say the invoice was paid? Anything but a clear "yes" is no. */
export async function checkPaymentNotice(ai: AiClient, input: PaymentNoticeInput): Promise<{ paid: boolean; usage: AiUsage }> {
  const prompt = paymentNoticePrompt({ ...input, body: clip(stripQuotedHistory(input.body), MAX_BODY_CHARS) });
  const result = await ai.complete({ job: "payment-notice", ...prompt, maxTokens: 2000 });
  const answer = firstJson(result.text).paid;
  if (answer !== "yes" && answer !== "no") throw new AiError("Payment notice answer was not in the expected format");
  return { paid: answer === "yes", usage: result };
}

export interface ProposedColumns {
  name: number | null;
  price: number | null;
  code: number | null;
  unit: number | null;
  aliases: number | null;
}

/**
 * Which column of a price list holds what, when the column titles do not say.
 * Returns column numbers only (null = could not tell); the caller checks them
 * against the sheet and the customer confirms.
 */
export async function proposePriceListColumns(
  ai: AiClient,
  input: PriceListColumnsInput,
): Promise<{ columns: ProposedColumns; usage: AiUsage }> {
  const result = await ai.complete({ job: "price-list-columns", ...priceListColumnsPrompt(input), maxTokens: 2000 });
  const answer = firstJson(result.text);
  const column = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
  if (!("name" in answer) || !("price" in answer)) {
    throw new AiError("Price list columns answer was not in the expected format");
  }
  return {
    columns: {
      name: column(answer.name),
      price: column(answer.price),
      code: column(answer.code),
      unit: column(answer.unit),
      aliases: column(answer.aliases),
    },
    usage: result,
  };
}

export async function buildVoiceProfile(
  ai: AiClient,
  input: VoiceProfileInput,
): Promise<{ profile: string; usage: AiUsage }> {
  const prompt = voiceProfilePrompt({ ...input, samples: input.samples.map((s) => clip(s, MAX_BODY_CHARS)) });
  const result = await ai.complete({ job: "voice-profile", ...prompt, maxTokens: 4000 });
  const profile = result.text.trim();
  if (!profile) throw new AiError("Model returned an empty voice profile");
  return { profile, usage: result };
}
