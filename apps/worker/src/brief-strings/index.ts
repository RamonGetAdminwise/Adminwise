import { en, type BriefStrings } from "./en";

/** One entry per language the brief exists in. To add one: copy en.ts, translate it, register it here. */
const LANGUAGES: Record<string, BriefStrings> = { en };

/** The brief's texts for a language code; English when that language has no translation yet. */
export function briefStrings(language: string = "en"): BriefStrings {
  return LANGUAGES[language] ?? en;
}

export type { BriefStrings };
