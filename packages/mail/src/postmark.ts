import {
  domainOf,
  flagsFromHeaders,
  FREE_MAIL,
  normalizeSubject,
  type InboundMessage,
  type OutboundEmail,
  type OutboundMailer,
} from "./types";

/** The parts of Postmark's inbound webhook JSON that we read. */
export interface PostmarkInboundPayload {
  FromFull?: { Email?: string; Name?: string };
  From?: string;
  ToFull?: { Email?: string }[];
  CcFull?: { Email?: string }[];
  BccFull?: { Email?: string }[];
  OriginalRecipient?: string;
  Subject?: string;
  MessageID?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  Headers?: { Name: string; Value: string }[];
  /** Content is the file, base64-encoded. */
  Attachments?: { Name?: string; ContentType?: string; Content?: string; ContentLength?: number }[];
}

export interface ParsedForward {
  /** Local parts of every recipient at our inbound domain: the customer slugs. */
  slugs: string[];
  /** Who sent the mail to the forwarding address (the customer, or the original sender on auto-forward). */
  forwardedBy: string;
  message: InboundMessage;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const FROM_LINE = /^\s*>?\s*(?:From|Od|Van|Von|De)\s*:\s*(.+)$/i;
const SUBJECT_LINE = /^\s*>?\s*(?:Subject|Temat|Onderwerp|Betreff)\s*:\s*(.+)$/i;
const HEADER_LINE = /^\s*>?\s*[\p{L} -]{2,20}:\s*\S/u;

/**
 * When a customer forwards a mail by hand, the real sender is inside the body
 * ("---------- Forwarded message ---------" / "From: ..."). This pulls out the
 * original sender, subject and text. Returns null if the body is not a forward.
 */
export function unwrapForward(text: string): { from: string; name: string; subject: string | null; body: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const fromMatch = FROM_LINE.exec(lines[i]!);
    if (!fromMatch) continue;
    const address = EMAIL.exec(fromMatch[1]!)?.[0];
    if (!address) continue;
    // The header block runs until the first blank line.
    let subject: string | null = null;
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() !== "" && HEADER_LINE.test(lines[end]!)) {
      const s = SUBJECT_LINE.exec(lines[end]!);
      if (s) subject = s[1]!.trim();
      end++;
    }
    if (end === i + 1) continue; // a lone "From:" line is not a forwarded header block
    const name = fromMatch[1]!.replace(EMAIL, "").replace(/[<>"[\]]/g, "").replace(/mailto:/i, "").trim();
    return {
      from: address.toLowerCase(),
      name,
      subject,
      body: lines
        .slice(end)
        .join("\n")
        .trim(),
    };
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `unwrap` decides whether a "From: ..." block inside the body is treated as
 * the real sender. Pass a function that says whether an address belongs to the
 * customer: only mail the customer forwarded by hand is unwrapped, so a normal
 * reply that merely quotes an older message keeps its real sender.
 */
export function parsePostmarkInbound(
  payload: PostmarkInboundPayload,
  inboundDomain: string,
  unwrap: boolean | ((forwardedBy: string) => boolean) = true,
): ParsedForward {
  const headers = (payload.Headers ?? []).map((h) => ({ name: h.Name, value: h.Value }));
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value;

  const recipients = [
    payload.OriginalRecipient,
    ...(payload.ToFull ?? []).map((r) => r.Email),
    ...(payload.CcFull ?? []).map((r) => r.Email),
    ...(payload.BccFull ?? []).map((r) => r.Email),
  ].filter((r): r is string => Boolean(r));
  const slugs = [
    ...new Set(
      recipients
        .map((r) => r.toLowerCase())
        .filter((r) => domainOf(r) === inboundDomain.toLowerCase())
        .map((r) => r.split("@")[0]!.split("+")[0]!),
    ),
  ];

  const forwardedBy = (payload.FromFull?.Email ?? EMAIL.exec(payload.From ?? "")?.[0] ?? "").toLowerCase();
  const rawText = payload.TextBody?.trim() ? payload.TextBody : htmlToText(payload.HtmlBody ?? "");
  const shouldUnwrap = typeof unwrap === "function" ? unwrap(forwardedBy) : unwrap;
  const inner = shouldUnwrap ? unwrapForward(rawText) : null;

  const from = inner ? { address: inner.from, name: inner.name } : { address: forwardedBy, name: payload.FromFull?.Name ?? "" };
  const subject = (inner?.subject ?? payload.Subject ?? "").replace(/^(\s*(fw|fwd|pd|doorst|wg)\s*:\s*)+/i, "");
  const messageId = header("message-id") ?? null;
  const references = header("references")?.trim().split(/\s+/)[0];
  // Without message references, a conversation is "same subject, same other party". For a company
  // domain the party is the company; for a mailbox provider (gmail.com) it is the one address,
  // or two strangers writing "Question" would land in one conversation.
  const party = FREE_MAIL.has(domainOf(from.address)) ? from.address : domainOf(from.address);
  const threadKey =
    (!inner && (references ?? header("in-reply-to")?.trim())) || `subj:${normalizeSubject(subject)}:${party}`;

  return {
    slugs,
    forwardedBy,
    message: {
      providerMessageId: payload.MessageID ?? messageId ?? "",
      internetMessageId: messageId,
      threadKey,
      subject,
      from,
      receivedAt: payload.Date && !Number.isNaN(Date.parse(payload.Date)) ? new Date(payload.Date) : new Date(),
      bodyText: inner ? inner.body : rawText,
      // Flags of a hand-forwarded mail describe the forward, not the original, so they are dropped.
      headerFlags: inner ? {} : flagsFromHeaders(headers),
      attachmentNames: (payload.Attachments ?? []).map((a) => a.Name ?? "").filter(Boolean),
    },
  };
}

/**
 * The sender check (SPF) as the server that received the mail for us reported it. A mail can
 * carry several such lines: every server it passed through may have added one, and a mail that
 * was forwarded carries the ones from its first journey. Only the receiving server's own line
 * says anything about who handed the mail to us; Postmark writes "identity=mailfrom" and names
 * itself as receiver. Failing that, the topmost line is the most recent one.
 */
function receivedSpf(payload: PostmarkInboundPayload): string | null {
  const lines = (payload.Headers ?? []).filter((h) => h.Name.toLowerCase() === "received-spf").map((h) => h.Value);
  return lines.find((v) => /identity=mailfrom|postmarkapp\.com/i.test(v)) ?? lines[0] ?? null;
}

/**
 * Did the receiving server find a valid signature (DKIM) made by the domain in the From line?
 * It lists the results of its checks in one header ("X-Spam-Tests: DKIM_SIGNED,DKIM_VALID,
 * DKIM_VALID_AU,SPF_PASS"); "AU" means "of the author's domain". The topmost such header is the
 * receiving server's own.
 */
function signedByFromDomain(payload: PostmarkInboundPayload): boolean {
  const tests = (payload.Headers ?? []).find((h) => h.Name.toLowerCase() === "x-spam-tests")?.Value ?? "";
  return tests.split(/[\s,]+/).includes("DKIM_VALID_AU");
}

/**
 * Did this mail really come from the address in its From line? Anyone can write any From line,
 * so "the customer sent this themselves" is only believed when the receiving server confirms
 * it: by a valid signature of that domain, or by its sender check passing for that domain.
 *   pass          confirmed, by the signature or by the sender check
 *   unknown       no check was reported, or it does not say for whom: we cannot tell, and
 *                 believe the From line as before
 *   not_passed    no valid signature, and the sender check failed or gave no result
 *   other_domain  no valid signature, and the sender check passed for another domain than the
 *                 one in the From line
 */
export function senderCheck(payload: PostmarkInboundPayload): "pass" | "unknown" | "not_passed" | "other_domain" {
  // A valid signature of the From line's own domain settles it. Large providers (hotmail.com,
  // Microsoft 365, Google) hand mail over under a technical return address of another domain, so
  // the handover check alone would refuse their genuine mail; the signature is what says "this
  // really is from that domain". The receiving server reports it as DKIM_VALID_AU.
  if (signedByFromDomain(payload)) return "pass";
  const spf = receivedSpf(payload);
  if (!spf) return "unknown";
  if (!/^\s*pass\b/i.test(spf)) return "not_passed";
  const from = (payload.FromFull?.Email ?? EMAIL.exec(payload.From ?? "")?.[0] ?? "").toLowerCase();
  const envelope = /envelope-from=<?([^\s;>]+)>?/i.exec(spf)?.[1]?.toLowerCase();
  if (!envelope) return "unknown";
  const a = domainOf(from);
  const b = envelope.includes("@") ? domainOf(envelope) : envelope;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`) ? "pass" : "other_domain";
}

export function senderVerified(payload: PostmarkInboundPayload): boolean {
  const check = senderCheck(payload);
  return check === "pass" || check === "unknown";
}

/**
 * The mailbox that handed this mail to us, as the receiving server saw it (the "envelope
 * sender"), when its sender check passed; otherwise null. For a mail someone typed or forwarded
 * by hand it is their own address. For a mailbox rule that forwards automatically it is the
 * forwarding mailbox, while the From line still names the original writer; Gmail writes it as
 * "name+caf_=target@gmail.com", so a "+tag" is dropped.
 */
export function envelopeSender(payload: PostmarkInboundPayload): string | null {
  const spf = receivedSpf(payload);
  if (!spf || !/^\s*pass\b/i.test(spf)) return null;
  const envelope = /envelope-from=<?([^\s;>]+@[^\s;>]+)>?/i.exec(spf)?.[1]?.toLowerCase();
  if (!envelope) return null;
  const [local = "", domain = ""] = envelope.split("@");
  return `${local.split("+")[0]}@${domain}`;
}

/**
 * May this mail come in through a customer's forwarding address? Only when it was sent or
 * forwarded by one of the addresses the customer listed: either the From line names one (and
 * the sender check does not contradict it), or the mailbox that handed it over is one (an
 * automatic forwarding rule). `byHand` is true in the first case: the customer forwarded or
 * wrote it themselves.
 *
 * When refused, `why` says what happened, so the owner (or we) can tell what to do:
 *   not_listed          the sender is simply not one of their addresses (add it, or a stranger);
 *   check_not_passed    the From line names one of their addresses, but the sender check failed;
 *   check_other_domain  ...or the check passed for another domain than the one in the From line.
 */
export type RefusalReason = "not_listed" | "check_not_passed" | "check_other_domain";

export function acceptedForward(
  payload: PostmarkInboundPayload,
  accepted: Set<string>,
): { accepted: boolean; byHand: boolean; why: RefusalReason | null } {
  const from = (payload.FromFull?.Email ?? EMAIL.exec(payload.From ?? "")?.[0] ?? "").toLowerCase();
  const listed = accepted.has(from);
  const check = senderCheck(payload);
  const byHand = listed && (check === "pass" || check === "unknown");
  const via = envelopeSender(payload);
  const ok = byHand || (via !== null && accepted.has(via));
  const why: RefusalReason | null = ok ? null : !listed ? "not_listed" : check === "other_domain" ? "check_other_domain" : "check_not_passed";
  return { accepted: ok, byHand, why };
}

/** Sends our own transactional mail through Postmark. */
export class PostmarkMailer implements OutboundMailer {
  constructor(
    private readonly options: { serverToken: string; from: string; messageStream?: string; fetch?: typeof fetch },
  ) {}

  async send(email: OutboundEmail): Promise<void> {
    const response = await (this.options.fetch ?? fetch)("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-postmark-server-token": this.options.serverToken,
      },
      body: JSON.stringify({
        From: this.options.from,
        To: email.to.join(","),
        Subject: email.subject,
        TextBody: email.textBody,
        MessageStream: this.options.messageStream ?? "outbound",
        ...(email.attachments?.length
          ? {
              Attachments: email.attachments.map((a) => ({
                Name: a.name,
                ContentType: a.contentType,
                Content: Buffer.from(a.content).toString("base64"),
              })),
            }
          : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`Postmark send failed: ${response.status}`);
    }
  }
}

/**
 * Local development without a Postmark account: prints who would get which
 * mail. Bodies are never printed, with one exception the caller must opt into
 * (the sign-in link, which is not customer email).
 */
export class ConsoleMailer implements OutboundMailer {
  async send(email: OutboundEmail): Promise<void> {
    const files = email.attachments?.length ? ` attachments=${email.attachments.length}` : "";
    console.log(`[mail not sent: no POSTMARK_SERVER_TOKEN] to=${email.to.join(",")} subject="${email.subject}"${files}`);
    if (email.devPrintBody) console.log(email.textBody);
  }
}
