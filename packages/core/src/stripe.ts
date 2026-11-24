import { createHmac, timingSafeEqual } from "node:crypto";
import type { Plan } from "./billing";

/**
 * Everything we ask of Stripe, in one file. Payment happens on Stripe's own
 * pages (Checkout and the customer portal): card details never reach us.
 *
 * Stripe is called over plain HTTPS with form-encoded bodies. The API version
 * is pinned, so a change on Stripe's side cannot silently change what we read.
 */
export const STRIPE_API_VERSION = "2026-11-18.endive";

export type BillingInterval = "month" | "year";

/** Prices are found by these lookup keys, set by `pnpm stripe:setup`; no price id lives in configuration. */
export const priceLookupKey = (plan: Plan, interval: BillingInterval) => `adminwise_${plan}_${interval}`;
/** The portal configuration made by `pnpm stripe:setup` carries this marker. */
export const PORTAL_MARKER = "adminwise";

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

type Params = { [key: string]: string | number | boolean | null | undefined | Params | Params[] | string[] };

/** { a: { b: 1 }, c: [{ d: 2 }] } -> "a[b]=1&c[0][d]=2", the encoding Stripe expects. */
export function encodeForm(params: Params, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "object") parts.push(encodeForm(item, `${name}[${index}]`));
        else parts.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof value === "object") {
      parts.push(encodeForm(value, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

/** What we keep of a Stripe subscription. */
export interface SubscriptionState {
  id: string;
  stripeCustomerId: string;
  /** Stripe's own status word: active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused. */
  status: string;
  plan: Plan | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** Does this Stripe status mean "the customer has a running subscription"? Payment retries (past_due) still count. */
export const subscriptionIsLive = (status: string) => status === "active" || status === "trialing" || status === "past_due";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const seconds = (value: unknown): Date | null => (typeof value === "number" ? new Date(value * 1000) : null);

/** Reads a subscription as Stripe returns it. The paid-until date lives on the subscription item. */
export function readSubscription(raw: unknown): SubscriptionState {
  const sub = obj(raw);
  const item = obj((obj(sub.items).data as unknown[] | undefined)?.[0]);
  const lookup = str(obj(item.price).lookup_key) ?? "";
  const plan = /^adminwise_(start|run)_(month|year)$/.exec(lookup)?.[1] as Plan | undefined;
  const customer = typeof sub.customer === "string" ? sub.customer : str(obj(sub.customer).id);
  return {
    id: str(sub.id) ?? "",
    stripeCustomerId: customer ?? "",
    status: str(sub.status) ?? "",
    plan: plan ?? null,
    currentPeriodEnd: seconds(item.current_period_end) ?? seconds(sub.current_period_end),
    // A date to cancel at counts the same as "cancel at period end".
    cancelAtPeriodEnd: sub.cancel_at_period_end === true || typeof sub.cancel_at === "number",
  };
}

export interface StripeClient {
  createCustomer(input: { email: string; name: string; customerId: string }): Promise<string>;
  /** A page on stripe.com where the customer enters their card and starts the subscription. Returns its address. */
  createCheckout(input: {
    stripeCustomerId: string;
    plan: Plan;
    interval: BillingInterval;
    customerId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  /** A page on stripe.com to change card, switch plan, see invoices or cancel. Returns its address. */
  createPortal(input: { stripeCustomerId: string; returnUrl: string }): Promise<string>;
  /** The subscription a finished checkout created, or null when the checkout was not completed. */
  getCheckoutSubscription(sessionId: string): Promise<SubscriptionState | null>;
  getSubscription(subscriptionId: string): Promise<SubscriptionState>;
  /** Ends a subscription at once (closing an account). Already gone counts as done. */
  cancelSubscription(subscriptionId: string): Promise<void>;
  raw(method: "GET" | "POST" | "DELETE", path: string, params?: Params): Promise<Json>;
}

export function createStripeClient(config: { secretKey: string; automaticTax: boolean }, fetchFn: typeof fetch = fetch): StripeClient {
  async function raw(method: "GET" | "POST" | "DELETE", path: string, params: Params = {}): Promise<Json> {
    const form = encodeForm(params);
    const url = `https://api.stripe.com/v1${path}${method === "GET" && form ? `?${form}` : ""}`;
    const response = await fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? form : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok) {
      const error = obj(json.error);
      // Stripe's message names parameters and objects, never card data.
      throw new StripeError(str(error.message) ?? `Stripe answered ${response.status}`, response.status, str(error.code));
    }
    return json;
  }

  let portalConfiguration: string | null | undefined;
  async function findPortalConfiguration(): Promise<string | null> {
    if (portalConfiguration !== undefined) return portalConfiguration;
    const list = await raw("GET", "/billing_portal/configurations", { limit: 50, active: true });
    const ours = ((list.data as Json[] | undefined) ?? []).find((c) => obj(c.metadata).app === PORTAL_MARKER);
    portalConfiguration = str(ours?.id);
    return portalConfiguration;
  }

  return {
    raw,

    async createCustomer(input) {
      const customer = await raw("POST", "/customers", {
        email: input.email,
        name: input.name || undefined,
        metadata: { adminwise_customer_id: input.customerId },
      });
      return str(customer.id)!;
    },

    async createCheckout(input) {
      const prices = await raw("GET", "/prices", { lookup_keys: [priceLookupKey(input.plan, input.interval)], active: true });
      const price = str(obj((prices.data as unknown[] | undefined)?.[0]).id);
      if (!price) throw new StripeError("The plan's price does not exist in Stripe yet (run pnpm stripe:setup)", 404, "price_missing");
      const session = await raw("POST", "/checkout/sessions", {
        mode: "subscription",
        customer: input.stripeCustomerId,
        client_reference_id: input.customerId,
        line_items: [{ price, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        // Which payment methods are offered is set in the Stripe dashboard (Settings, Payment methods):
        // this API version no longer accepts a list here.
        billing_address_collection: "required",
        // The customer can enter their VAT number on Stripe's page; name and address are saved for the invoice.
        tax_id_collection: { enabled: true },
        customer_update: { name: "auto", address: "auto" },
        automatic_tax: config.automaticTax ? { enabled: true } : undefined,
        subscription_data: { metadata: { adminwise_customer_id: input.customerId } },
      });
      return str(session.url)!;
    },

    async createPortal(input) {
      const configuration = await findPortalConfiguration();
      const session = await raw("POST", "/billing_portal/sessions", {
        customer: input.stripeCustomerId,
        return_url: input.returnUrl,
        configuration: configuration ?? undefined,
      });
      return str(session.url)!;
    },

    async getCheckoutSubscription(sessionId) {
      const session = await raw("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
      const subscription = str(session.subscription);
      if (session.status !== "complete" || !subscription) return null;
      return readSubscription(await raw("GET", `/subscriptions/${subscription}`));
    },

    async getSubscription(subscriptionId) {
      return readSubscription(await raw("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`));
    },

    async cancelSubscription(subscriptionId) {
      try {
        await raw("DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      } catch (error) {
        if (error instanceof StripeError && error.status === 404) return;
        throw error;
      }
    },
  };
}

/**
 * Checks that a webhook call really comes from Stripe: the "Stripe-Signature"
 * header holds a timestamp and an HMAC of "<timestamp>.<body>" made with the
 * endpoint's secret. Calls older than five minutes are refused (replays).
 */
export function verifyStripeSignature(body: string, header: string | null, secret: string, now: Date = new Date()): boolean {
  if (!header) return false;
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"));
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
