import { subscriptionIsLive } from "@adminwise/core";
import { forCustomer, system } from "@adminwise/db";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getConfig, getDb, getStripe } from "@/lib/server";

/**
 * Stripe sends the customer back here after a finished checkout. The account is
 * brought in step with the new subscription right away, so the customer does
 * not have to wait for Stripe's webhook (which does the same a moment later).
 */
export async function GET(request: NextRequest) {
  const config = getConfig();
  const to = (query: string) => NextResponse.redirect(`${config.appBaseUrl}/settings?${query}#plan`);
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${config.appBaseUrl}/signin`);
  const stripe = getStripe();
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!stripe || !sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return to("error=checkout");

  try {
    const customer = await forCustomer(getDb(), session.customerId).getCustomer();
    const sub = await stripe.getCheckoutSubscription(sessionId);
    // Only a subscription of this account's own Stripe customer counts: a session id from elsewhere changes nothing.
    if (!sub || !customer.stripeCustomerId || sub.stripeCustomerId !== customer.stripeCustomerId) return to("error=checkout");
    await system(getDb()).applySubscription({ ...sub, live: subscriptionIsLive(sub.status) });
  } catch (error) {
    console.error("[billing return]", error instanceof Error ? `${error.name}: ${error.message}` : "error");
    return to("error=checkout");
  }
  return to("saved=subscribed");
}
