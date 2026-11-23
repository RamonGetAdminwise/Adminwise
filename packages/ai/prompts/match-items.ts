import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: say which price list item a sender means, for items that could not be
 * recognised by their code. For every requested item the model gets a short
 * numbered list of candidates from the price list and answers with a candidate
 * number, "ambiguous" or "none". It cannot name anything that is not on the
 * list and never sees or states a price.
 */
export interface MatchItemsInput {
  /** Each requested item with its candidates; the candidate's place in the list is its number. */
  items: { request: string; candidates: { code: string; name: string; aliases: string[]; unit: string }[] }[];
}

export function matchItemsPrompt(input: MatchItemsInput): { system: string; user: string } {
  const system = `
You match what a customer asked for to items on a company's price list.

${SHARED_RULES}

Task: for each requested item below there is a numbered list of candidates from the
price list. Decide for each requested item:

- "match": one candidate is the product or service asked for. Give its number in
  "candidate". This is the answer when:
  - only one candidate is that kind of product or service, also when the request
    is in another language, uses another word for it, or adds what it is for
    ("a patient brochure of 16 pages" is the 16-page brochure; "packaging design
    for our coffees" is packaging design; "VAT registration" is VAT registration,
    not EU VAT registration, which the sender would have named);
  - several candidates are the same thing in different sizes or packages and the
    request says enough to choose one. An amount "up to" a limit is the smallest
    package that covers it: "about 40 documents a month" is the package up to 60,
    not the one up to 30; "about 8 pages" is the website up to 10 pages.
- "ambiguous": two or more candidates fit and the request does not say which
  (the size, type or package is missing: "a logo" when there are two logo
  packages; "the annual tax return" when there are three). "candidate" is null.
- "none": no candidate is the product or service asked for. A similar product,
  another size than the one asked for, or a related part is not a match.
  "candidate" is null.

Never choose a candidate that the sender did not ask for. If the request names
two different things at once, match the one named first.

Decide before you answer. Answer once, with JSON and nothing else, and write
nothing after it. One entry per requested item, in the same order:
{"matches":[{"item":<number of the requested item>,"result":"match|ambiguous|none","candidate":<number or null>}]}
`.trim();

  const user = input.items
    .map((item, index) =>
      [
        `Requested item ${index + 1}:`,
        emailData(`requested item ${index + 1}`, item.request),
        `Candidates for requested item ${index + 1}:`,
        ...item.candidates.map(
          (c, n) => `  ${n + 1}. ${[c.code, c.name, c.aliases.join(", "), c.unit].filter(Boolean).join(" | ")}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
  return { system, user };
}
