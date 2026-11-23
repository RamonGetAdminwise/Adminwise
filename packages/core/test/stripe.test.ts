import { createHmac, randomBytes } from "node:crypto";
import { createDb, forCustomer, system, type Db } from "@adminwise/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createStripeClient, encodeForm, loadConfig, readSubscription, StripeError, subscriptionIsLive, verifyStripeSignature } from "../src";

/** A stand-in for Stripe: answers by path, remembers every call. */
function fakeStripe(answers: Record<string, unknown>, status = 200) {
  const calls: { method: string; url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace("/v1", "");
    calls.push({ method: init?.method ?? "GET", url: String(url), body: String(init?.body ?? ""), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(answers[`${init?.method} ${path}`] ?? {}), { status });
  }) as typeof fetch;
  return { calls, client: createStripeClient({ secretKey: "sk_test_example", automaticTax: false }, fetchFn) };
}

// A subscription as Stripe returns it in the pinned API version: the paid-until date is on the item.
const rawSub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  cancel_at: null,
  items: { data: [{ id: "si_1", current_period_end: 1_800_000_000, price: { id: "price_1", lookup_key: "adminwise_run_month" } }] },
  ...over,
});

describe("talking to Stripe", () => {
  it("encodes nested values the way Stripe expects", () => {
    expect(decodeURIComponent(encodeForm({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { a: "b c" }, skip: undefined, none: null, flag: true })))
      .toBe("mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[a]=b c&flag=true");
    expect(decodeURIComponent(encodeForm({ lookup_keys: ["a", "b"] }))).toBe("lookup_keys[0]=a&lookup_keys[1]=b");
  });

  it("reads plan, paid-until date and cancellation from a subscription", () => {
    expect(readSubscription(rawSub())).toEqual({
      id: "sub_1", stripeCustomerId: "cus_1", status: "active", plan: "run", currentPeriodEnd: new Date(1_800_000_000_000), cancelAtPeriodEnd: false,
    });
    expect(readSubscription(rawSub({ cancel_at_period_end: true })).cancelAtPeriodEnd).toBe(true);
    expect(readSubscription(rawSub({ cancel_at: 1_800_000_000 })).cancelAtPeriodEnd).toBe(true);
    expect(readSubscription(rawSub({ customer: { id: "cus_9" } })).stripeCustomerId).toBe("cus_9");
    // A price that is not one of ours gives no plan, never a guessed one.
    expect(readSubscription(rawSub({ items: { data: [{ price: { lookup_key: "something_else" } }] } }))).toMatchObject({ plan: null, currentPeriodEnd: null });
    expect(readSubscription({})).toMatchObject({ id: "", status: "", plan: null });
  });

  it("counts a subscription as running while a failed payment is retried, not after it ended", () => {
    expect(["active", "trialing", "past_due"].every(subscriptionIsLive)).toBe(true);
    expect(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", ""].some(subscriptionIsLive)).toBe(false);
  });

  it("starts a checkout for the right price, with a pinned API version and no card data of ours", async () => {
    const stripe = fakeStripe({
      "GET /prices": { data: [{ id: "price_start_year" }] },
      "POST /checkout/sessions": { url: "https://checkout.stripe.com/c/pay/cs_test_1" },
    });
    const url = await stripe.client.createCheckout({
      stripeCustomerId: "cus_1", plan: "start", interval: "year", customerId: "customer-uuid",
      successUrl: "https://app.test/api/billing/return?session_id={CHECKOUT_SESSION_ID}", cancelUrl: "https://app.test/settings#plan",
    });
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(decodeURIComponent(stripe.calls[0]!.url)).toContain("lookup_keys[0]=adminwise_start_year");
    const sent = decodeURIComponent(stripe.calls[1]!.body);
    for (const part of ["mode=subscription", "customer=cus_1", "client_reference_id=customer-uuid", "line_items[0][price]=price_start_year", "tax_id_collection[enabled]=true", "billing_address_collection=required"]) {
      expect(sent, part).toContain(part);
    }
    expect(sent).not.toContain("automatic_tax");
    expect(stripe.calls[1]!.headers).toMatchObject({ authorization: "Bearer sk_test_example", "stripe-version": "2026-11-18.endive" });
  });

  it("says so when the plans were never created in Stripe, and passes Stripe's own errors on", async () => {
    const empty = fakeStripe({ "GET /prices": { data: [] } });
    await expect(empty.client.createCheckout({ stripeCustomerId: "cus_1", plan: "run", interval: "month", customerId: "c", successUrl: "s", cancelUrl: "c" }))
      .rejects.toThrow("pnpm stripe:setup");
    const refused = fakeStripe({ "GET /subscriptions/sub_x": { error: { message: "No such subscription", code: "resource_missing" } } }, 404);
    await expect(refused.client.getSubscription("sub_x")).rejects.toMatchObject({ name: "StripeError", status: 404, code: "resource_missing" });
    // Cancelling something that is already gone is not an error.
    await expect(refused.client.cancelSubscription("sub_x")).resolves.toBeUndefined();
    expect(new StripeError("x", 500, null)).toBeInstanceOf(Error);
  });

  it("only reports a subscription for a checkout that was completed", async () => {
    const open = fakeStripe({ "GET /checkout/sessions/cs_1": { status: "open", subscription: null } });
    expect(await open.client.getCheckoutSubscription("cs_1")).toBeNull();
    const done = fakeStripe({ "GET /checkout/sessions/cs_1": { status: "complete", subscription: "sub_1" }, "GET /subscriptions/sub_1": rawSub() });
    expect(await done.client.getCheckoutSubscription("cs_1")).toMatchObject({ id: "sub_1", plan: "run", status: "active" });
  });

  it("reads Stripe settings from configuration", () => {
    const base = { DATABASE_URL: "x", TOKEN_ENCRYPTION_KEY: "k" };
    expect(loadConfig(base as NodeJS.ProcessEnv)).toMatchObject({ stripe: null, billingEnabled: false });
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: " sk_test_example ", STRIPE_WEBHOOK_SECRET: "whsec_example", BILLING_ENABLED: "TRUE" } as NodeJS.ProcessEnv))
      .toMatchObject({ stripe: { secretKey: "sk_test_example", webhookSecret: "whsec_example", automaticTax: false }, billingEnabled: true });
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_example";
  const body = '{"type":"customer.subscription.updated"}';
  const now = new Date("2026-11-24T10:00:00Z");
  const t = Math.floor(now.getTime() / 1000);
  const sign = (timestamp: number, payload = body, key = secret) => createHmac("sha256", key).update(`${timestamp}.${payload}`).digest("hex");

  it("accepts a call signed by Stripe", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(t)}`, secret, now)).toBe(true);
    // During a secret roll Stripe sends two signatures: one valid is enough.
    expect(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)},v1=${sign(t)}`, secret, now)).toBe(true);
  });

  it("refuses a changed body, a wrong secret, an old call and a missing header", () => {
    expect(verifyStripeSignature(`${body} `, `t=${t},v1=${sign(t)}`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(t, body, "whsec_other")}`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t - 301},v1=${sign(t - 301)}`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=short`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, `v1=${sign(t)}`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, null, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, "", secret, now)).toBe(false);
  });
});

describe("keeping an account in step with its subscription", () => {
  let db: Db;
  beforeAll(() => {
    db = createDb({ connectionString: inject("databaseUrl"), encryptionKey: Buffer.alloc(32, 7).toString("base64"), max: 2 });
  });
  afterAll(async () => {
    await db.close();
  });
  async function newCustomer() {
    const tag = randomBytes(4).toString("hex");
    const { customerId } = await system(db).createCustomerWithUser({ email: `owner.${tag}@nordpart.example`, slug: `nordpart-${tag}` });
    const scope = forCustomer(db, customerId);
    await scope.setStripeCustomerId(`cus_${tag}`);
    return { scope, customerId, stripeCustomerId: `cus_${tag}` };
  }
  const paidUntil = new Date("2026-12-24T00:00:00Z");
  const now = new Date("2026-11-24T10:00:00Z");

  it("makes a new account a trial on Run, and remembers its Stripe customer only once", async () => {
    const a = await newCustomer();
    expect(await a.scope.getCustomer()).toMatchObject({ billingStatus: "trial", plan: "run", stripeCustomerId: a.stripeCustomerId, stripeSubscriptionId: null });
    await a.scope.setStripeCustomerId("cus_other");
    expect((await a.scope.getCustomer()).stripeCustomerId).toBe(a.stripeCustomerId);
  });

  it("activates on payment, follows a plan switch and a cancellation, and goes read-only when it ends", async () => {
    const a = await newCustomer();
    const sys = system(db);
    const sub = { id: "sub_a1", stripeCustomerId: a.stripeCustomerId, live: true, plan: "start" as const, currentPeriodEnd: paidUntil, cancelAtPeriodEnd: false };

    expect(await sys.applySubscription(sub, now)).toBe(a.customerId);
    expect(await a.scope.getCustomer()).toMatchObject({ billingStatus: "active", plan: "start", stripeSubscriptionId: "sub_a1", currentPeriodEnd: paidUntil, cancelAtPeriodEnd: false });
    // The same event again changes nothing.
    await sys.applySubscription(sub, now);
    await sys.applySubscription({ ...sub, plan: "run" }, now);
    expect((await a.scope.getCustomer()).plan).toBe("run");
    // Cancelled by the owner: still active until the period ends.
    await sys.applySubscription({ ...sub, plan: "run", cancelAtPeriodEnd: true }, now);
    expect(await a.scope.getCustomer()).toMatchObject({ billingStatus: "active", cancelAtPeriodEnd: true });

    // The period is over (or payments failed for good).
    await sys.applySubscription({ ...sub, live: false, plan: "run" }, now);
    expect(await a.scope.getCustomer()).toMatchObject({ billingStatus: "read_only", readOnlySince: now, cancelAtPeriodEnd: false });

    // They come back with a new subscription: active again, and the deletion clock is cleared.
    await db.pool.query("UPDATE customers SET deletion_warning_sent_at = now() WHERE id = $1", [a.customerId]);
    await sys.applySubscription({ ...sub, id: "sub_a2" }, now);
    expect(await a.scope.getCustomer()).toMatchObject({ billingStatus: "active", plan: "start", stripeSubscriptionId: "sub_a2", readOnlySince: null });
    // A late "ended" event about the OLD subscription must not switch the new one off.
    expect(await sys.applySubscription({ ...sub, live: false }, now)).toBeNull();
    expect((await a.scope.getCustomer()).billingStatus).toBe("active");
  });

  it("does not end a trial because a checkout was abandoned, keeps our own accounts internal, and ignores strangers", async () => {
    const sys = system(db);
    const trial = await newCustomer();
    await sys.applySubscription({ id: "sub_t1", stripeCustomerId: trial.stripeCustomerId, live: false, plan: "run", currentPeriodEnd: null, cancelAtPeriodEnd: false }, now);
    expect((await trial.scope.getCustomer()).billingStatus).toBe("trial");

    const own = await newCustomer();
    await db.pool.query("UPDATE customers SET billing_status = 'internal' WHERE id = $1", [own.customerId]);
    await sys.applySubscription({ id: "sub_o1", stripeCustomerId: own.stripeCustomerId, live: true, plan: "start", currentPeriodEnd: paidUntil, cancelAtPeriodEnd: false }, now);
    await sys.applySubscription({ id: "sub_o1", stripeCustomerId: own.stripeCustomerId, live: false, plan: "start", currentPeriodEnd: paidUntil, cancelAtPeriodEnd: false }, now);
    expect((await own.scope.getCustomer()).billingStatus).toBe("internal");

    expect(await sys.applySubscription({ id: "sub_x", stripeCustomerId: "cus_nobody", live: true, plan: "run", currentPeriodEnd: paidUntil, cancelAtPeriodEnd: false }, now)).toBeNull();
  });
});
