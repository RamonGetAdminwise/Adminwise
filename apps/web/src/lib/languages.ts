/**
 * The languages a customer works in, as a choice instead of codes to type. The first one is the
 * main language: it is used when the language of an email is not clear.
 */
export const LANGUAGE_CHOICES: [code: string, name: string][] = [
  ["en", "English"],
  ["pl", "Polish"],
  ["de", "German"],
  ["nl", "Dutch"],
  ["fr", "French"],
  ["it", "Italian"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["cs", "Czech"],
  ["sk", "Slovak"],
  ["uk", "Ukrainian"],
  ["hu", "Hungarian"],
  ["ro", "Romanian"],
  ["lt", "Lithuanian"],
  ["sv", "Swedish"],
  ["da", "Danish"],
];

const CODE = /^[a-z]{2}$/;

/** The name of a language for people; a code that is not in the list keeps a readable name where one exists. */
export function languageName(code: string): string {
  const known = LANGUAGE_CHOICES.find(([c]) => c === code)?.[1];
  if (known) return known;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The list to choose from: the fixed choices, plus anything this customer already has that is not among them. */
export function languageOptions(current: string[]): [string, string][] {
  const extra = current.filter((code) => CODE.test(code) && !LANGUAGE_CHOICES.some(([c]) => c === code));
  return [...LANGUAGE_CHOICES, ...extra.map((code): [string, string] => [code, languageName(code)])];
}

/** Reads the main language and the ticked other languages from a form: main first, no doubles. Empty when no main language was chosen. */
export function readLanguages(form: FormData): string[] {
  const main = form.get("mainLanguage");
  if (typeof main !== "string" || !CODE.test(main)) return [];
  const others = form.getAll("language").filter((value): value is string => typeof value === "string" && CODE.test(value));
  return [...new Set([main, ...others])].slice(0, 12);
}
