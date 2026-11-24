import { SHARED_RULES } from "./shared-rules";

/**
 * Job: write a payment reminder for one unpaid invoice, in the customer's voice.
 * There are three levels, drafted 7, 14 and 30 days after the due date. The
 * draft goes to the owner, who reviews and sends it; nothing is sent
 * automatically. The invoice facts come from our records, where each was
 * checked against the invoice itself.
 */
export interface PaymentReminderInput {
  companyName: string;
  voiceProfile: string;
  /** ISO 639-1 code of the language to write in (the invoice's language). */
  language: string;
  /** 1 = friendly, 2 = firm, 3 = last reminder. */
  level: 1 | 2 | 3;
  invoiceNumber: string;
  /** Formatted with currency, for example "26 372,43 PLN". */
  amount: string;
  /** YYYY-MM-DD */
  dueDate: string;
  daysOverdue: number;
}

const TONES: Record<PaymentReminderInput["level"], string> = {
  1: "First reminder. Friendly and light: the invoice may simply have been overlooked. Ask them to arrange payment, or to let you know if it has already been paid.",
  2: "Second reminder. Polite but firm: refer to the earlier reminder, state clearly that the invoice is overdue, and ask for payment within the next few days or for a short reply about when it will be paid.",
  3: "Third and last reminder. Serious and factual, still courteous: the invoice is well overdue despite two reminders. Ask for immediate payment and say that otherwise you will have to consider further steps. Do not name specific legal steps, fees or interest.",
};

export function paymentReminderPrompt(input: PaymentReminderInput): { system: string; user: string } {
  const system = `
You draft payment reminders for ${input.companyName || "a small company"}. The owner reads every
draft before it is sent, so write the reminder they would write themselves.

${SHARED_RULES}

How this company writes (voice profile, written by us from their own sent mail):
<voice_profile>
${input.voiceProfile || "No profile yet: write politely, briefly and concretely."}
</voice_profile>

Task: write the body of a payment reminder for one invoice.

Facts (from our records; use them exactly as given and add no others):
- Invoice number: ${input.invoiceNumber}
- Amount to pay: ${input.amount}
- Due date: ${input.dueDate}
- Days overdue today: ${input.daysOverdue}

Tone: ${TONES[input.level]}

- Write in this language: ${input.language}. Match the voice profile (greeting,
  formality, closing phrase), within the tone above.
- State the invoice number, the amount and the due date once, exactly as given.
- Three to five sentences.
- Do not add interest, fees, a new deadline date, bank details or any amount
  other than the one given. Do not threaten.
- End with the closing phrase only. Do not add a name, signature or company footer.
- Plain text. No subject line.
`.trim();

  return { system, user: "Write the reminder now." };
}
