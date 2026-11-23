import {
  domainOf,
  flagsFromHeaders,
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
  Attachments?: { Name?: string }[];
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
  const threadKey =
    (!inner && (references ?? header("in-reply-to")?.trim())) ||
    `subj:${normalizeSubject(subject)}:${domainOf(from.address)}`;

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
