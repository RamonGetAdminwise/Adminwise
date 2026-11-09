import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: describe how a customer writes, from three emails they sent.
 * Runs once at onboarding; the customer sees and can edit the result.
 */
export interface VoiceProfileInput {
  companyName: string;
  samples: string[];
}

export function voiceProfilePrompt(input: VoiceProfileInput): { system: string; user: string } {
  const system = `
You study how ${input.companyName || "a small company"} writes email, so that later drafts sound like them.

${SHARED_RULES}

Task: from the sent emails below, write a voice profile of at most 150 words that
another writer could follow. Cover:
- greeting and closing phrases they actually use, per language if they differ
- formality and form of address (first name, Mr/Ms, "Pan/Pani", "u/je" and so on)
- sentence length and structure (short and direct, or longer and explanatory)
- habits worth copying (bullet lists, thanking first, stating next steps, emoji or none)

Describe style only. Do not copy names of people, companies, prices, phone numbers
or any other content from the emails into the profile. Write the profile in English,
quoting greeting and closing phrases in their original language.
`.trim();

  const user = input.samples.map((sample, i) => emailData(`sent email ${i + 1}`, sample)).join("\n\n");
  return { system, user };
}
