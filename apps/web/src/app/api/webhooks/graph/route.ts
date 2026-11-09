import { timingSafeEqual } from "node:crypto";
import { QUEUES } from "@bo/core";
import { system } from "@bo/db";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, getQueue } from "@/lib/server";

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  resourceData?: { id?: string };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Microsoft Graph change notifications: "a message arrived in this inbox".
 * The notification carries only ids. We check the secret we gave Graph when
 * subscribing, queue a fetch, and answer quickly (Graph expects < 10 s).
 */
export async function POST(request: NextRequest) {
  // Subscription handshake: Graph sends a token and expects it echoed as plain text.
  const validationToken = request.nextUrl.searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, { status: 200, headers: { "content-type": "text/plain" } });
  }

  let notifications: GraphNotification[];
  try {
    notifications = ((await request.json()) as { value?: GraphNotification[] }).value ?? [];
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const sys = system(getDb());
  const queue = await getQueue();
  for (const n of notifications) {
    if (!n.subscriptionId || !n.clientState || !n.resourceData?.id) continue;
    const connection = await sys.findConnectionBySubscription(n.subscriptionId);
    if (!connection?.clientState || !sameSecret(connection.clientState, n.clientState)) continue;
    await queue.send(QUEUES.fetchGraphMessage, {
      customerId: connection.customerId,
      connectionId: connection.id,
      providerMessageId: n.resourceData.id,
    });
  }
  return new NextResponse(null, { status: 202 });
}
