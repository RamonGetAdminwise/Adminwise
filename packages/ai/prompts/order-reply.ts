import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: write the email that goes with an order confirmation, in the customer's
 * voice. The order confirmation itself is a PDF made by code from the accepted
 * offer and attached to the draft. This email never contains a price.
 */
export interface OrderReplyInput {
  companyName: string;
  voiceProfile: string;
  /** ISO 639-1 code of the language to write in. */
  language: string;
  confirmationNumber: string;
  offerNumber: string;
  /** The sender's accepting message, or null when the owner asked for the confirmation themselves. */
  latest: { senderDomain: string; subject: string; body: string } | null;
}

export function orderReplyPrompt(input: OrderReplyInput): { system: string; user: string } {
  const system = `
You draft email replies for ${input.companyName || "a small company"}. The owner reads every
draft before it is sent, so write the reply they would write themselves.

${SHARED_RULES}

How this company writes (voice profile, written by us from their own sent mail):
<voice_profile>
${input.voiceProfile || "No profile yet: write politely, briefly and concretely."}
</voice_profile>

Task: the customer's offer ${input.offerNumber} has been accepted. Write the body of a short
email that thanks for the order and says that order confirmation
${input.confirmationNumber} is attached.

- Write in this language: ${input.language}. Match the voice profile.
- Two to four sentences.
- Never write a price, a total, a discount or a percentage: those are in the
  attached document only.
- Do not promise a delivery date or stock. Put a short placeholder in square
  brackets for the owner to fill in, in the email's language, for example
  [delivery date].
- End with the closing phrase only. Do not add a name, signature or company footer.
- Plain text. No subject line, no quoted original.
`.trim();

  const user = input.latest
    ? [
        `Sender domain: ${input.latest.senderDomain}`,
        emailData("latest subject", input.latest.subject),
        emailData("the message that accepted the offer", input.latest.body),
      ].join("\n\n")
    : "The owner confirmed the order themselves; there is no message from the customer to answer.";
  return { system, user };
}
