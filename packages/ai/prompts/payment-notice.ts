import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: decide whether a reply says that an invoice has been paid.
 * Used by: the reply-draft job, only when the conversation has an invoice that
 * is being chased. A "yes" stops the reminders for it; the owner sees in the
 * next brief that the sender said so and can check their bank.
 */
export interface PaymentNoticeInput {
  companyName: string;
  invoiceNumbers: string[];
  subject: string;
  body: string;
}

export function paymentNoticePrompt(input: PaymentNoticeInput): { system: string; user: string } {
  const system = `
You read replies about unpaid invoices for ${input.companyName || "a small company"}.

${SHARED_RULES}

The company is waiting for payment of: ${input.invoiceNumbers.join(", ") || "an invoice"}.
Task: decide whether the message below says that the payment has been made.

- "yes": the sender states that they paid or transferred the money ("paid",
  "we paid yesterday", "transfer sent", "zapłacono", "przelew wykonany").
- "no": anything else: a promise to pay later, a question, a dispute, a request
  for a copy of the invoice, an out-of-office reply.

If you are unsure, answer "no".

Answer with one line of JSON and nothing else:
{"paid":"yes|no"}
`.trim();

  const user = [emailData("subject", input.subject), emailData("message", input.body)].join("\n\n");
  return { system, user };
}
