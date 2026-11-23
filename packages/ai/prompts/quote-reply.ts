import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: write the reply to a quote request, in the customer's voice.
 * The offer itself (items, prices, totals, discount) is a PDF made by code and
 * attached to the draft. This email only accompanies it and asks about anything
 * that could not be offered. It never contains a price, a total or a discount.
 */
export interface QuoteReplyInput {
  companyName: string;
  voiceProfile: string;
  /** ISO 639-1 code of the language to write in (the sender's language). */
  language: string;
  /** Null when nothing could be priced: then there is no attachment. */
  offer: { number: string; validUntil: string; items: { name: string; quantity: string; unit: string }[] } | null;
  /** What could not be offered, and why. */
  unclear: {
    request: string;
    reason: "not_found" | "ambiguous" | "no_quantity";
    /** For "ambiguous": the price list items it could be. For "no_quantity": the item that was recognised. */
    options: string[];
  }[];
  latest: { senderDomain: string; subject: string; body: string };
}

export function quoteReplyPrompt(input: QuoteReplyInput): { system: string; user: string } {
  const offered = input.offer
    ? [
        `An offer is attached to this email as a PDF: number ${input.offer.number}, valid until ${input.offer.validUntil}.`,
        "It contains these items (prices and totals are in the PDF only):",
        ...input.offer.items.map((i) => `- ${i.quantity} ${i.unit} ${i.name}`.replace(/\s+/g, " ")),
      ].join("\n")
    : "No offer is attached: nothing in the request could be priced yet.";

  const reasons: Record<QuoteReplyInput["unclear"][number]["reason"], (options: string[]) => string> = {
    not_found: () => "we could not find this on our price list: ask what exactly they need (type, size, parameters), or say that you will check",
    ambiguous: (options) => `it could be several items: ask which one they mean${options.length ? ` (${options.join("; ")})` : ""}`,
    no_quantity: (options) => `no quantity was given${options.length ? ` for ${options[0]}` : ""}: ask how many they need`,
  };
  const open = input.unclear.length
    ? ["These requested items are NOT in the offer. Ask about each of them:", ...input.unclear.map((u, i) => `${i + 1}. ${reasons[u.reason](u.options)}`)].join("\n")
    : "Every requested item is in the offer.";

  const system = `
You draft email replies for ${input.companyName || "a small company"}. The owner reads every
draft before it is sent, so write the reply they would write themselves.

${SHARED_RULES}

How this company writes (voice profile, written by us from their own sent mail):
<voice_profile>
${input.voiceProfile || "No profile yet: write politely, briefly and concretely."}
</voice_profile>

Task: write the body of a reply to a quote request.

Facts you may use (prepared by our system, not by the sender):
${offered}

${open}

- Write in this language: ${input.language}. Match the voice profile.
- ${input.offer ? "Say that the offer is attached and mention its number and until when it is valid." : "Do not mention any attachment or offer document."}
- Never write a price, a total, a discount or a percentage in this email, even if
  the sender asks for one: those are only in the attached offer.
- For each item that is not in the offer, ask the question described above, in one
  clear sentence, referring to the item in the sender's words (shown below).
- If the sender asks about delivery time or stock, do not guess: put a short
  placeholder in square brackets for the owner to fill in, in the reply's
  language, for example [delivery time].
- End with the closing phrase only. Do not add a name, signature or company footer.
- Plain text. No subject line, no quoted original.
`.trim();

  const user = [
    ...input.unclear.map((u, i) => emailData(`requested item ${i + 1} that is not in the offer, in the sender's words`, u.request)),
    `Sender domain: ${input.latest.senderDomain}`,
    emailData("latest subject", input.latest.subject),
    emailData("latest message", input.latest.body),
  ].join("\n\n");
  return { system, user };
}
