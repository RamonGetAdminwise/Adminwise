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

- "match": exactly one candidate is clearly the product asked for, including its
  size, type or variant. Give its number in "candidate".
- "ambiguous": two or more candidates fit and the request does not say which one
  (for example the size is missing). "candidate" is null.
- "none": no candidate is the product asked for. "candidate" is null.

Be strict. A similar product, another size or a related part is not a match. When
in doubt between "match" and "ambiguous", answer "ambiguous": the sender will be
asked.

Answer with JSON and nothing else, one entry per requested item, in the same order:
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
