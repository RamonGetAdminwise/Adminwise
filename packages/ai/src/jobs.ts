import { chaserCheckPrompt, type ChaserCheckInput } from "../prompts/chaser-check";
import { chaserDraftPrompt, type ChaserDraftInput } from "../prompts/chaser-draft";
import { classifyPrompt, type ClassifyInput } from "../prompts/classify";
import { fileTypePrompt, type FileTypeInput } from "../prompts/file-type";
import { priceListColumnsPrompt, type PriceListColumnsInput } from "../prompts/price-list-columns";
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
