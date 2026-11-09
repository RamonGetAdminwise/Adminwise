import { classifyPrompt, type ClassifyInput } from "../prompts/classify";
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
