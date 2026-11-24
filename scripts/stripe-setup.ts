import { createStripeClient, PORTAL_MARKER, priceLookupKey, type BillingInterval } from "../packages/core/src/stripe";
import type { Plan } from "../packages/core/src/billing";

/**
 * `pnpm stripe:setup`: creates, in the Stripe account whose key is in
 * STRIPE_SECRET_KEY, what the app expects to find there:
 *   - two products (Start, Run) with a monthly and a yearly price each, in EUR,
 *     found later by their lookup keys;
 *   - one customer-portal configuration that lets a customer change card,
 *     switch plan, see invoices and cancel at the end of the period.
 * Safe to run again: what exists is left alone. Run it once in the sandbox and
 * once with the live key when paid plans start. Prints ids, never the key.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}
const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error("STRIPE_SECRET_KEY is not set.");
  process.exit(1);
}
console.log(secretKey.startsWith("sk_test_") ? "Stripe sandbox (test key)." : "LIVE Stripe account.");
const stripe = createStripeClient({ secretKey, automaticTax: false });

// Prices confirmed on 2026-11-09, in euro cents, without VAT.
const PLANS: { plan: Plan; name: string; description: string; month: number; year: number }[] = [
  { plan: "start", name: "Adminwise Start", description: "Follow-ups, filing, daily brief and reply drafts.", month: 1900, year: 19000 },
  { plan: "run", name: "Adminwise Run", description: "Everything in Start, plus offers, order confirmations and payment reminders.", month: 4900, year: 49000 },
];

type Listed = { data?: { id: string; metadata?: Record<string, string>; lookup_key?: string; product?: string }[] };
const priceIds: Record<string, string> = {};
const productIds: Record<string, string> = {};

const products = (await stripe.raw("GET", "/products", { limit: 100, active: true })) as Listed;
for (const p of PLANS) {
  let product = products.data?.find((x) => x.metadata?.adminwise_plan === p.plan)?.id;
  if (!product) {
    product = (await stripe.raw("POST", "/products", { name: p.name, description: p.description, metadata: { adminwise_plan: p.plan } })).id as string;
    console.log(`created product ${p.name}: ${product}`);
  } else console.log(`product ${p.name} exists: ${product}`);
  productIds[p.plan] = product;

  for (const interval of ["month", "year"] as BillingInterval[]) {
    const key = priceLookupKey(p.plan, interval);
    const found = (await stripe.raw("GET", "/prices", { lookup_keys: [key], active: true })) as Listed;
    let price = found.data?.[0]?.id;
    if (!price) {
      price = (
        await stripe.raw("POST", "/prices", {
          product,
          currency: "eur",
          unit_amount: p[interval],
          recurring: { interval },
          lookup_key: key,
          tax_behavior: "exclusive",
        })
      ).id as string;
      console.log(`  created price ${key}: EUR ${(p[interval] / 100).toFixed(2)} per ${interval} (${price})`);
    } else console.log(`  price ${key} exists: ${price}`);
    priceIds[key] = price;
  }
}

const portals = (await stripe.raw("GET", "/billing_portal/configurations", { limit: 50, active: true })) as Listed;
if (portals.data?.some((c) => c.metadata?.app === PORTAL_MARKER)) {
  console.log("customer portal configuration exists.");
} else {
  const created = await stripe.raw("POST", "/billing_portal/configurations", {
    metadata: { app: PORTAL_MARKER },
    business_profile: { headline: "Adminwise: your plan, card and invoices" },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["name", "address", "tax_id", "email"] },
      // Cancelling runs to the end of the paid period; nothing is refunded.
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products: PLANS.map((p) => ({
          product: productIds[p.plan]!,
          prices: [priceIds[priceLookupKey(p.plan, "month")]!, priceIds[priceLookupKey(p.plan, "year")]!],
        })),
      },
    },
  });
  console.log(`created customer portal configuration: ${created.id as string}`);
}
console.log("Done.");
