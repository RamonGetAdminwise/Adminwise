import { subscriptionIsLive, verifyStripeSignature } from "@adminwise/core";
import { system } from "@adminwise/db";
import { NextResponse, type NextRequest } from "next/server";
import { getConfig, getDb, getStripe } from "@/lib/server";

/** Events that say "something about a subscription changed". */
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

/**
 * Stripe tells us here when a subscription starts, changes, is cancelled or
 * ends after failed payments. The event is only a signal: after checking its
 * signature we ask Stripe for the subscription as it is now and bring the
 * account in step with that, so events that arrive late, twice or out of order
 * do no harm.
 */
export async function POST(request: NextRequest) {
  const config = getConfig();
  const stripe = getStripe();
  if (!stripe || !config.stripe?.webhookSecret) return new NextResponse(null, { status: 503 });

  const body = await request.text();
  if (!verifyStripeSignature(body, request.headers.get("stripe-signature"), config.stripe.webhookSecret)) {
    return new NextResponse(null, { status: 400 });
  }
  let event: { type?: string; data?: { object?: { id?: string; subscription?: unknown; mode?: string } } };
  try {
    event = JSON.parse(body) as typeof event;
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const object = event.data?.object;
  let subscriptionId: string | null = null;
  if (event.type && SUBSCRIPTION_EVENTS.has(event.type)) subscriptionId = object?.id ?? null;
  else if (event.type === "checkout.session.completed" && typeof object?.subscription === "string") subscriptionId = object.subscription;
  // Anything else is acknowledged and ignored.
  if (!subscriptionId || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) return NextResponse.json({ received: true });

  // A failure here answers 500, and Stripe sends the event again later.
  const sub = await stripe.getSubscription(subscriptionId);
  await system(getDb()).applySubscription({ ...sub, live: subscriptionIsLive(sub.status) });
  return NextResponse.json({ received: true });
}
