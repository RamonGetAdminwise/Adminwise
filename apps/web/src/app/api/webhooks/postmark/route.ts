import { timingSafeEqual } from "node:crypto";
import { ingestInbound } from "@adminwise/core";
import { forCustomer, system } from "@adminwise/db";
import { parsePostmarkInbound, type PostmarkInboundPayload } from "@adminwise/mail";
import { NextResponse, type NextRequest } from "next/server";
import { getConfig, getDb, getQueue } from "@/lib/server";

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
  const { slugs } = parsePostmarkInbound(payload, config.inboundDomain, false);

  for (const slug of slugs) {
    const customerId = await sys.findCustomerIdBySlug(slug);
    if (!customerId) continue; // unknown address: accept and drop, so Postmark does not retry
    const scope = forCustomer(db, customerId);
    const [users, connection] = await Promise.all([scope.listUsers(), scope.getConnectionByProvider("forwarding")]);
    const ownAddresses = new Set(users.map((u) => u.email));
    // Unwrap "Forwarded message" blocks only when the customer forwarded the mail by hand.
    const { message } = parsePostmarkInbound(payload, config.inboundDomain, (from) => ownAddresses.has(from));
    await ingestInbound(scope, queue, connection?.id ?? null, message);
  }
  return NextResponse.json({ ok: true });
}
