import { createHash, timingSafeEqual } from "node:crypto";
import { entitlements, ingestInbound, QUEUES } from "@adminwise/core";
import { forCustomer, system } from "@adminwise/db";
import { parsePostmarkInbound, type PostmarkInboundPayload } from "@adminwise/mail";
import { extractPdfText } from "@adminwise/offers";
import { NextResponse, type NextRequest } from "next/server";
import { getConfig, getDb, getQueue } from "@/lib/server";

/** Forwarded PDFs outside these sizes are not looked at as invoices. */
const MIN_PDF_BYTES = 2 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDFS_PER_MAIL = 3;

function authorized(request: NextRequest, secret: string): boolean {
  // Postmark calls https://postmark:<secret>@host/api/webhooks/postmark (HTTP basic auth).
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  const password = Buffer.from(header.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
  const a = Buffer.from(password);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Forwarding-address intake. Postmark receives mail for <slug>@<inbound domain>
 * and posts it here; it goes into the same messages table as Microsoft 365 mail.
 *
 * When the customer themselves forwards a mail with a PDF, the PDF may be one
 * of their own invoices to track for payment reminders. The file is not kept:
 * its text is taken out here, noted for at most a day, and read by the worker.
 */
export async function POST(request: NextRequest) {
  const config = getConfig();
  if (!config.postmark.inboundSecret) return new NextResponse(null, { status: 503 });
  if (!authorized(request, config.postmark.inboundSecret)) return new NextResponse(null, { status: 401 });

  let payload: PostmarkInboundPayload;
  try {
    payload = (await request.json()) as PostmarkInboundPayload;
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const db = getDb();
  const sys = system(db);
  const queue = await getQueue();
  const { slugs, forwardedBy } = parsePostmarkInbound(payload, config.inboundDomain, false);

  for (const slug of slugs) {
    const customerId = await sys.findCustomerIdBySlug(slug);
    if (!customerId) continue; // unknown address: accept and drop, so Postmark does not retry
    const scope = forCustomer(db, customerId);
    // A read-only account (trial over, not paying): accept and drop, nothing is stored.
    if (!entitlements(await scope.getCustomer(), new Date(), config.billingEnabled).work) continue;
    const [users, connection] = await Promise.all([scope.listUsers(), scope.getConnectionByProvider("forwarding")]);
    const ownAddresses = new Set(users.map((u) => u.email));
    // Unwrap "Forwarded message" blocks only when the customer forwarded the mail by hand.
    const { message } = parsePostmarkInbound(payload, config.inboundDomain, (from) => ownAddresses.has(from));
    const { messageId } = await ingestInbound(scope, queue, connection?.id ?? null, message);

    // Only mail the customer forwarded themselves, and only the first time we see it.
    if (!messageId || !ownAddresses.has(forwardedBy)) continue;
    const stored = await scope.getMessage(messageId);
    const pdfs = (payload.Attachments ?? [])
      .filter((a) => /\.pdf$/i.test(a.Name ?? "") || a.ContentType === "application/pdf")
      .slice(0, MAX_PDFS_PER_MAIL);
    for (const pdf of pdfs) {
      const bytes = new Uint8Array(Buffer.from(pdf.Content ?? "", "base64"));
      if (bytes.byteLength < MIN_PDF_BYTES || bytes.byteLength > MAX_PDF_BYTES) continue;
      const text = await extractPdfText(bytes);
      const invoiceId = await scope.createInvoice({
        source: "forwarded",
        messageId,
        threadId: stored?.threadId ?? null,
        connectionId: connection?.id ?? null,
        fileName: pdf.Name ?? "attachment.pdf",
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        status: text ? "pending" : "unreadable",
        pendingText: text,
      });
      if (invoiceId && text) await queue.send(QUEUES.readInvoice, { customerId, invoiceId });
    }
  }
  return NextResponse.json({ ok: true });
}
