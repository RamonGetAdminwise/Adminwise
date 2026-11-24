/**
 * The guided test at the end of "Getting started": we send the owner one
 * invented customer question from our own address, it arrives in their mailbox
 * like any other mail, and a reply draft appears. Nothing is sent from the
 * customer's mailbox, and the mail goes to the owner only.
 */

const TEST_MAILS: Record<string, { subject: string; body: string }> = {
  en: {
    subject: "Question about your delivery time",
    body:
      "Hello,\n\n" +
      "We are looking for a new supplier and came across your company. Could you tell me how quickly you usually " +
      "deliver after an order, and who I should contact to place a first order?\n\n" +
      "Thank you,\nAnna Wrona",
  },
  pl: {
    subject: "Pytanie o termin dostawy",
    body:
      "Dzień dobry,\n\n" +
      "szukamy nowego dostawcy i trafiliśmy na Państwa firmę. Proszę o informację, jak szybko zwykle realizują " +
      "Państwo dostawę po złożeniu zamówienia i z kim mogę się skontaktować w sprawie pierwszego zamówienia.\n\n" +
      "Pozdrawiam\nAnna Wrona",
  },
};

/** The test mail, in the owner's first working language when we have it, otherwise in English. */
export function setupTestMail(languages: string[], appName: string): { subject: string; textBody: string } {
  const mail = TEST_MAILS[languages[0] ?? "en"] ?? TEST_MAILS.en!;
  // Nothing in the mail says it is a test, and the product's name is not in it: a line like that
  // makes the sorting step take it for an automatic notice, and then no draft appears. The guide
  // page tells the owner what the mail is.
  void appName;
  return { subject: mail.subject, textBody: `${mail.body}\n` };
}

/** "Adminwise <hello@getadminwise.com>" -> "getadminwise.com" */
const domainOf = (address: string) => /@([^\s>]+)/.exec(address)?.[1]?.toLowerCase() ?? "";

/**
 * Mail from the customer's own domain counts as a colleague and gets no draft.
 * When our sending address is on that domain the test mail cannot work, and the
 * guide asks the owner to send themselves a mail from another address instead.
 */
export function testMailWouldBeInternal(mailFrom: string, ownAddresses: string[]): boolean {
  const ours = domainOf(mailFrom);
  return ours !== "" && ownAddresses.some((address) => domainOf(address) === ours);
}

export type SetupTestState =
  | "not_sent"
  /** Sent a short while ago; nothing handled yet. */
  | "waiting"
  /** A draft was written after the test mail was sent. */
  | "drafted"
  /** Mail arrived after the test mail was sent, but none of it got a draft. */
  | "no_draft"
  /** Sent long enough ago that it should have arrived. */
  | "nothing_arrived";

const WAIT_MINUTES = 10;

/** Where the guided test stands, from the customer's own activity log. */
export function setupTestState(
  sentAt: Date | null,
  runs: { job: string; status: string; outcome: string | null; startedAt: Date }[],
  now: Date,
): SetupTestState {
  if (!sentAt) return "not_sent";
  const since = runs.filter((run) => run.job === "reply-draft" && run.startedAt >= sentAt && run.status === "succeeded");
  if (since.some((run) => /^(drafted|offer|clarify|order):/.test(run.outcome ?? ""))) return "drafted";
  if (since.length > 0) return "no_draft";
  return now.getTime() - sentAt.getTime() < WAIT_MINUTES * 60_000 ? "waiting" : "nothing_arrived";
}
