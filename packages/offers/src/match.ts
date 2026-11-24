/**
 * Finding which price list item a sender means.
 *
 * Step 1, here, by code: if the request names an item code from the price
 * list ("PZ-40", "pz 40", "PZ40"), that is the item. No model is involved.
 * Step 2, for what is left: the model is shown a short list of candidates,
 * chosen here by shared words, and answers with a candidate number, or says
 * that it is ambiguous or not there. It cannot answer with anything that is not
 * on the list, and it never supplies a price.
 */

export interface MatchableItem {
  id: string;
  code: string;
  name: string;
  aliases: string[];
}

/**
 * Units that are a period or a whole job: someone who asks for "bookkeeping, about 50 documents
 * a month" or "a website of about 8 pages" wants one of them, and says no number because there
 * is none to say. Only the exact unit counts: "osoba/mies." (per person per month) or
 * "zaległy mies." still need a number.
 */
const SINGLE_UNITS = new Set([
  "mies", "miesiac", "miesiecznie", "rok", "rocznie", "jednorazowo", "ryczalt", "projekt",
  "month", "monthly", "year", "yearly", "oneoff", "once", "project", "flatfee",
  "maand", "permaand", "jaar", "perjaar", "eenmalig",
  "monat", "jahr", "einmalig", "pauschal",
]);

/** True when an item with this unit is, by its nature, ordered once: the quantity is 1 when none is stated. */
export function unitMeansOne(unit: string): boolean {
  const plain = unit
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z/]/g, "");
  return SINGLE_UNITS.has(plain);
}

/** Letters and digits only, upper case: "pz-40", "PZ 40" and "Pz40" are the same code. */
const compact = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Lower case words without accents: "Łożysko" and "lozysko" are the same word. */
export function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
}

/**
 * The item whose code the request names. Returns "ambiguous" when the request
 * names the codes of several different items, and null when it names none.
 */
export function matchByCode<T extends MatchableItem>(request: string, items: T[]): T | "ambiguous" | null {
  // Tokens as written, plus neighbours joined: "PZ 40" also gives "PZ40".
  const tokens = request.split(/[\s,;:()"']+/).filter(Boolean);
  const spoken = new Set<string>();
  tokens.forEach((token, i) => {
    spoken.add(compact(token));
    if (i + 1 < tokens.length) spoken.add(compact(token + tokens[i + 1]!));
  });
  const found = items.filter((item) => {
    const code = compact(item.code);
    // Very short codes ("A1") would match by accident, and so would codes of digits only
    // ("100" in "hose 100 mm", "2026" in a date): those go to the model with the item names.
    return code.length >= 3 && /\d/.test(code) && /[A-Z]/.test(code) && spoken.has(code);
  });
  if (found.length === 0) return null;
  return found.length === 1 ? found[0]! : "ambiguous";
}

/**
 * The price list items most likely meant by a request, best first, by shared
 * words in name, other names and code. Numbers count double: "pump 40" should
 * rank PZ-40 above PZ-50. Only items sharing at least one word are returned.
 */
export function rankCandidates<T extends MatchableItem>(request: string, items: T[], limit = 12): T[] {
  const asked = new Set(words(request));
  if (asked.size === 0) return [];
  return items
    .map((item, index) => {
      const own = new Set(words(`${item.code} ${item.name} ${item.aliases.join(" ")}`));
      let score = 0;
      for (const word of asked) if (own.has(word)) score += /\d/.test(word) ? 2 : 1;
      return { item, score, index };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((candidate) => candidate.item);
}
