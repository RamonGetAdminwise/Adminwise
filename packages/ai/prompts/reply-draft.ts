import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: write a reply draft in the customer's voice.
 * The draft lands in the customer's Drafts folder; a person always reviews it.
 */
export interface ReplyDraftInput {
  companyName: string;
  voiceProfile: string;
  /** ISO 639-1 code of the language to write in (the sender's language). */
  language: string;
  latest: { senderDomain: string; subject: string; body: string };
  /** Earlier messages of the same thread, oldest first. Context only. */
  history: { direction: "inbound" | "outbound"; date: string; body: string }[];
}

export function replyDraftPrompt(input: ReplyDraftInput): { system: string; user: string } {
  const system = `
You draft email replies for ${input.companyName || "a small company"}. The owner reads every
draft before it is sent, so write the reply they would write themselves.

${SHARED_RULES}

How this company writes (voice profile, written by us from their own sent mail):
<voice_profile>
${input.voiceProfile || "No profile yet: write politely, briefly and concretely."}
</voice_profile>

Task: write the body of a reply to the message marked "message to answer".

- Answer only what that latest message asks. Earlier messages in the thread are
  background: use them to understand the conversation, do not answer them again.
- Write in this language: ${input.language}. Match the voice profile (greeting,
  formality, sentence length, closing phrase).
- If answering needs a fact you were not given (a price, a date, availability, a
  decision), do not guess. Put a short placeholder in square brackets where the
  owner must fill it in, in the reply's language, for example [price] or
  [confirm delivery date].
- End with the closing phrase only. Do not add a name, signature, contact details
  or company footer: the signature is added automatically.
- Plain text. No subject line, no quoted original, no notes to the owner outside
  square-bracket placeholders.
`.trim();

  const history = input.history.length
    ? [
        "Earlier in this thread (background only, oldest first):",
        ...input.history.map((m, i) =>
          emailData(
            `earlier message ${i + 1}, ${m.direction === "outbound" ? "written by the company" : "written by the other party"}, ${m.date}`,
            m.body,
          ),
        ),
      ].join("\n\n")
    : "There are no earlier messages in this thread.";

  const user = [
    history,
    "Message to answer (the latest one):",
    `Sender domain: ${input.latest.senderDomain}`,
    emailData("latest subject", input.latest.subject),
    emailData("latest message", input.latest.body),
  ].join("\n\n");

  return { system, user };
}
