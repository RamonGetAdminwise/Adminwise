import { createStripeClient, priceLookupKey, readSubscription, subscriptionIsLive } from "../packages/core/src/stripe";

/**
 * `pnpm check:stripe`: a round trip through the Stripe SANDBOX, to prove that
 * our code reads Stripe's answers correctly: a test customer, a checkout page,
 * a subscription paid with Stripe's test card, a plan switch, cancelling, and
 * the portal page. Everything it creates is removed again at the end.
 * Refuses to run with a live key. Run `pnpm stripe:setup` first.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}
const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
if (!secretKey.startsWith("sk_test_")) {
  console.error("Refused: this check only runs with a sandbox key (sk_test_...).");
  process.exit(1);
}
const stripe = createStripeClient({ secretKey, automaticTax: false });
let differences = 0;
const report = (ok: boolean, what: string) => {
  if (!ok) differences++;
  console.log(`${ok ? "ok  " : "DIFF"}  ${what}`);
};

const customer = await stripe.createCustomer({ email: "owner@nordpart.example", name: "Nordpart sp. z o.o.", customerId: "00000000-0000-0000-0000-000000000000" });
try {
  const checkout = await stripe.createCheckout({
    stripeCustomerId: customer,
    plan: "run",
    interval: "month",
    customerId: "00000000-0000-0000-0000-000000000000",
    successUrl: "https://app.adminwise.example/api/billing/return?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://app.adminwise.example/settings#plan",
  });
  report(checkout.startsWith("https://checkout.stripe.com/"), "checkout page created on checkout.stripe.com");

  // Pay with Stripe's test card, the way a finished checkout would.
  const card = (await stripe.raw("POST", "/payment_methods/pm_card_visa/attach", { customer })).id as string;
  const price = async (key: string) => ((await stripe.raw("GET", "/prices", { lookup_keys: [key] })).data as { id: string }[])[0]!.id;
  const created = await stripe.raw("POST", "/subscriptions", {
    customer,
    items: [{ price: await price(priceLookupKey("start", "month")) }],
    default_payment_method: card,
  });
  let sub = await stripe.getSubscription(created.id as string);
  report(sub.status === "active" && subscriptionIsLive(sub.status), `subscription status: ${sub.status}`);
  report(sub.plan === "start", `plan read from the price: ${sub.plan}`);
  report(sub.stripeCustomerId === customer, "belongs to the test customer");
  const days = sub.currentPeriodEnd ? Math.round((sub.currentPeriodEnd.getTime() - Date.now()) / 86_400_000) : null;
  report(days !== null && days >= 27 && days <= 31, `paid until ${sub.currentPeriodEnd?.toISOString().slice(0, 10)} (${days} days from now)`);
  report(sub.cancelAtPeriodEnd === false, "not cancelled");

  // Switch to Run, yearly (what the portal does).
  const itemId = ((created.items as { data: { id: string }[] }).data)[0]!.id;
  sub = readSubscription(await stripe.raw("POST", `/subscriptions/${sub.id}`, { items: [{ id: itemId, price: await price(priceLookupKey("run", "year")) }] }));
  report(sub.plan === "run", `after the switch: plan ${sub.plan}`);

  // The owner cancels: it runs to the end of the period.
  sub = readSubscription(await stripe.raw("POST", `/subscriptions/${sub.id}`, { cancel_at_period_end: true }));
  report(sub.cancelAtPeriodEnd && subscriptionIsLive(sub.status), `cancelled at period end, still ${sub.status}`);

  const portal = await stripe.createPortal({ stripeCustomerId: customer, returnUrl: "https://app.adminwise.example/settings#plan" });
  report(portal.startsWith("https://billing.stripe.com/"), "portal page created on billing.stripe.com");

  // Closing an account ends it at once; doing it twice is harmless.
  await stripe.cancelSubscription(sub.id);
  await stripe.cancelSubscription(sub.id).catch(() => report(false, "cancelling twice failed"));
  sub = await stripe.getSubscription(sub.id);
  report(sub.status === "canceled" && !subscriptionIsLive(sub.status), `after cancelling now: ${sub.status}`);
} catch (error) {
  report(false, error instanceof Error ? `${error.name}: ${error.message}` : "error");
} finally {
  await stripe.raw("DELETE", `/customers/${customer}`);
  console.log("      test customer removed");
}
console.log(differences === 0 ? "\nAll as expected." : `\n${differences} difference(s): read the lines marked DIFF.`);
process.exit(differences === 0 ? 0 : 1);
