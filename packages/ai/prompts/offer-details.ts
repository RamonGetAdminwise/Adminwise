import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: read the company's own standing details from one of its past offers or
 * invoices, so the owner does not have to type them during setup.
 * Used by: the "Getting started" guide and the offer settings page.
 * The model's answer is a proposal: afterwards code keeps a value only when it
 * is printed in the document, and the owner confirms before anything is used.
 */
export interface OfferDetailsInput {
  companyName: string;
  /** Text taken from the PDF. */
  text: string;
}

export function offerDetailsPrompt(input: OfferDetailsInput): { system: string; user: string } {
  const system = `
You read a past offer or invoice of ${input.companyName || "a small company"} to find that
company's own standing details. The company is the SELLER on the document: the
one that made the offer or issued the invoice. The other party is the buyer;
never report the buyer's details.

${SHARED_RULES}

Task: the text below was taken from a PDF. Report:

- "company_lines": the seller's name, address, tax number and registration
  numbers, one printed line per entry, exactly as printed, at most 8 entries.
- "bank_lines": the seller's bank name, account number and SWIFT/BIC code, one
  printed line per entry, exactly as printed, at most 5 entries.
- "payment_terms": the sentence or phrase that states the payment terms,
  exactly as printed (for example "Payment within 14 days by bank transfer"),
  or null. A due date alone is not a payment term.
- "currency": the three-letter currency code of the amounts, or null.
- "vat_rate": the VAT rate in percent as a number if one rate is printed, or null.
- "language": the ISO 639-1 code of the language the document is written in.

Copy values as they are printed. Use an empty list or null for anything that is
not printed: never fill in a likely value, and never report line items, prices,
totals, dates, document numbers or anything about the buyer.

Answer with one line of JSON and nothing else:
{"company_lines":[],"bank_lines":[],"payment_terms":null,"currency":null,"vat_rate":null,"language":"en"}
`.trim();

  return { system, user: emailData("text of the document", input.text) };
}
