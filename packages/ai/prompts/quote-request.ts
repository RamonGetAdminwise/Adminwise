import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: decide whether an email asks for a quote and, if so, list what is asked.
 * Used by: the reply-draft job, for business mail of customers who have a
 * price list. The model only reports what the sender wrote. It does not look
 * anything up and never states a price; matching and pricing are done by code.
 */
export interface QuoteRequestInput {
  companyName: string;
  subject: string;
  body: string;
}

export function quoteRequestPrompt(input: QuoteRequestInput): { system: string; user: string } {
  const system = `
You read incoming email for ${input.companyName || "a small company"} that sells goods or services
from a price list.

${SHARED_RULES}

Task: decide whether the sender asks for a price, an offer or a quote for specific
goods or services, and list each thing they ask for.

- "is_quote_request" is "yes" only when the sender wants prices or an offer for
  something they name. A question about availability, delivery, an existing order
  or an invoice is "no". A general "send me your price list" is "no".
- One entry in "items" per distinct product or service asked for.
  - "request": the sender's own words for that item, copied from the email, at most
    120 characters. Keep any item code, size or type they wrote.
  - "quantity": the number they state for that item, as a number. If they state no
    quantity, use null. Never estimate or assume a quantity.
  - "unit": the unit they state (pcs, m, kg, szt., ks ...), or null.
- If it is not a quote request, "items" is an empty list.

Answer with JSON and nothing else:
{"is_quote_request":"yes|no","items":[{"request":"...","quantity":<number or null>,"unit":<"..." or null>}]}
`.trim();

  const user = [emailData("subject", input.subject), emailData("body", input.body)].join("\n\n");
  return { system, user };
}
