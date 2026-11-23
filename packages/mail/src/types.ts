/** One incoming email, in the same shape whichever provider it came from. */
export interface InboundMessage {
  providerMessageId: string;
  /** RFC Message-ID header; the best key for "is this the same email again?" */
  internetMessageId: string | null;
  /** Groups messages of one conversation. */
  threadKey: string;
  subject: string;
  from: { address: string; name: string };
  receivedAt: Date;
  bodyText: string;
  headerFlags: HeaderFlags;
  attachmentNames: string[];
  /** Addresses the message was sent to (lower case). Filled for Microsoft 365; used for the customer's own sent mail. */
  to?: string[];
  cc?: string[];
}

/** One file attached to a message, without its content. */
export interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  /** Pictures placed inside the mail text (logos in signatures). */
  isInline: boolean;
}

export interface HeaderFlags {
  /** Auto-Submitted / X-Autoreply: an out-of-office or other automatic reply. */
  autoSubmitted?: boolean;
  /** Precedence: bulk/junk/list. */
  bulk?: boolean;
  /** List-Unsubscribe / List-Id present: a mailing list. */
  list?: boolean;
}

export interface OutboundEmail {
  to: string[];
  subject: string;
  textBody: string;
  /** Development only: lets the console mailer print the text (used for the sign-in link, never for customer mail). */
  devPrintBody?: boolean;
}

/** Our own transactional mail: sign-in links, drafts emailed back, the daily brief. */
export interface OutboundMailer {
  send(email: OutboundEmail): Promise<void>;
}

export function flagsFromHeaders(headers: { name: string; value: string }[]): HeaderFlags {
  const get = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value.toLowerCase();
  const flags: HeaderFlags = {};
  const auto = get("auto-submitted");
  if ((auto && auto !== "no") || get("x-autoreply") || get("x-autorespond") || get("x-auto-response-suppress")) {
    flags.autoSubmitted = true;
  }
  const precedence = get("precedence");
  if (precedence && ["bulk", "junk", "list"].includes(precedence.trim())) flags.bulk = true;
  if (get("list-unsubscribe") || get("list-id")) flags.list = true;
  return flags;
}

export function domainOf(address: string): string {
  return address.split("@")[1]?.trim().toLowerCase() ?? "";
}

/** "Re: RE: Odp: Fwd: Offer" -> "offer" */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd|odp|pd|aw|wg|antw|doorst)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}
