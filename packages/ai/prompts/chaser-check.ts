import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: decide whether a message the company sent expects an answer.
 * Used by: the nightly chaser, before any follow-up is drafted. Only threads
 * where the answer is yes are ever followed up.
 */
export interface ChaserCheckInput {
  companyName: string;
  subject: string;
  /** The company's own last message in the thread. */
  body: string;
}

export function chaserCheckPrompt(input: ChaserCheckInput): { system: string; user: string } {
  const system = `
You help ${input.companyName || "a small company"} decide whether to follow up on an email
they sent that has not been answered.

${SHARED_RULES}

Task: read the company's own last message below and decide whether it expects an
answer from the other party.

- "yes": it asks a question, makes an offer or quote, requests something (a
  decision, a document, a payment, a date, a confirmation), or proposes something
  the other party must react to.
- "no": it only thanks, confirms, informs or closes the conversation ("thank you",
  "received", "see you then", "attached as agreed" with nothing asked), or it is an
  automatic or internal note.

If you are unsure, answer "no": an unnecessary follow-up is worse than a missed one.

Answer with one line of JSON and nothing else:
{"expects_reply":"yes|no"}
`.trim();

  const user = [emailData("subject", input.subject), emailData("the company's last message", input.body)].join("\n\n");
  return { system, user };
}
