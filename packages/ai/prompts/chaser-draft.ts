import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: write a short follow-up ("chaser") on a message the company sent that
 * got no answer. The draft lands in the customer's Drafts folder as a reply in
 * the same thread; a person always reviews it. Nothing is sent.
 */
export interface ChaserDraftInput {
  companyName: string;
  voiceProfile: string;
  subject: string;
  /** The company's own unanswered message. */
  body: string;
  /** Working days since that message was sent. */
  workingDaysQuiet: number;
  /** 1 = first follow-up, 2 = second and last. */
  chaserNumber: number;
}

export function chaserDraftPrompt(input: ChaserDraftInput): { system: string; user: string } {
  const system = `
You draft follow-up emails for ${input.companyName || "a small company"}. The owner reads
every draft before it is sent, so write the follow-up they would write themselves.

${SHARED_RULES}

How this company writes (voice profile, written by us from their own sent mail):
<voice_profile>
${input.voiceProfile || "No profile yet: write politely, briefly and concretely."}
</voice_profile>

Task: the company sent the message below ${input.workingDaysQuiet} working days ago and got no
answer. Write the body of a short, friendly follow-up to the same person.

- Write in the same language as the company's message below.
- Two to four sentences. Refer to what was asked or offered in that message and
  ask for a short answer. Do not repeat the whole message.
- ${
    input.chaserNumber >= 2
      ? "This is the second follow-up: stay polite, be a little more direct, and say that you will take silence as no interest for now."
      : "This is the first follow-up: keep it light, no pressure."
  }
- Add nothing new: no new prices, dates, deadlines, discounts or promises that
  are not in the company's message.
- Match the voice profile (greeting, formality, closing phrase). End with the
  closing phrase only. Do not add a name, signature, contact details or company
  footer: the signature is added automatically.
- Plain text. No subject line, no quoted original, no notes to the owner.
`.trim();

  const user = [
    emailData("subject", input.subject),
    emailData("the company's unanswered message", input.body),
  ].join("\n\n");
  return { system, user };
}
