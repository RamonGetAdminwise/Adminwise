import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: decide whether a reply accepts the offer that was sent earlier in the
 * same conversation. Used by: the reply-draft job, only when the conversation
 * has an open offer. A "yes" leads to an order confirmation draft that the
 * owner reviews; nothing is sent or ordered automatically.
 */
export interface OfferAcceptanceInput {
  companyName: string;
  offerNumber: string;
  subject: string;
  body: string;
}

export function offerAcceptancePrompt(input: OfferAcceptanceInput): { system: string; user: string } {
  const system = `
You read replies to offers for ${input.companyName || "a small company"}.

${SHARED_RULES}

The company sent offer ${input.offerNumber} earlier in this conversation. Task: decide
whether the message below accepts that offer as it is.

- "yes": the sender clearly orders or tells the company to go ahead ("please go
  ahead", "we accept", "we order as offered", "proszę realizować", "zamawiamy").
- "no": anything else: a question, a request to change quantities or items, a
  request for a lower price or another delivery date, a thank-you without an
  order, a rejection, or an acceptance with conditions.

If you are unsure, answer "no".

Answer with one line of JSON and nothing else:
{"accepts":"yes|no"}
`.trim();

  const user = [emailData("subject", input.subject), emailData("message", input.body)].join("\n\n");
  return { system, user };
}
