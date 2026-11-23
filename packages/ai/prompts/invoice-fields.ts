import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: read the key fields from the text of a PDF that may be an invoice.
 * Used by: invoice tracking for payment reminders. The model's answer is a
 * proposal: afterwards code keeps a value only when that exact value is printed
 * in the text, so anything not on the document is dropped and the owner is asked.
 */
export interface InvoiceFieldsInput {
  companyName: string;
  /** The company's own address and tax number as it prints them, to tell seller from buyer. */
  companyDetails: string;
  /** Text taken from the PDF. */
  text: string;
}

export function invoiceFieldsPrompt(input: InvoiceFieldsInput): { system: string; user: string } {
  const system = `
You read documents for ${input.companyName || "a small company"}, to track which of its own
invoices are unpaid.

${SHARED_RULES}

The company's own details, to recognise it as the seller:
<company>
${input.companyName}
${input.companyDetails}
</company>

Task: the text below was taken from a PDF. Report:

- "is_invoice": "yes" if the document is an invoice (including a VAT invoice or a
  final invoice). An offer, a pro forma, an order confirmation, a credit note, a
  delivery note or a statement is "no".
- "issued_by_company": "yes" only if the company above is the SELLER (the one
  that issued the invoice and must be paid). If the company is the buyer, or you
  cannot tell, answer "no".
- "number": the invoice number exactly as printed, or null.
- "gross_amount": the total amount to pay including tax, exactly as printed
  (digits and separators, without the currency), or null.
- "currency": the three-letter currency code, or null.
- "issue_date" and "due_date": as YYYY-MM-DD, or null. Use the due date only if
  a due date is printed. Do not work one out yourself.
- "payment_term_days": the number of days if the document states the payment term
  in days (for example "14 days", "14 dni"), otherwise null.
- "buyer": the buyer's name exactly as printed, or null.
- "language": the ISO 639-1 code of the language the document is written in.

Copy values as they are printed. If a value is not printed, answer null for it:
never fill in a likely value.

Answer with one line of JSON and nothing else:
{"is_invoice":"yes|no","issued_by_company":"yes|no","number":null,"gross_amount":null,"currency":null,"issue_date":null,"due_date":null,"payment_term_days":null,"buyer":null,"language":"pl"}
`.trim();

  return { system, user: emailData("text of the document", input.text) };
}
