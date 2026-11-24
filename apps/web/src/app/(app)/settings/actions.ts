"use server";

import { buildVoiceProfile } from "@adminwise/ai";
import { checkVatNumber, EU_COUNTRIES, isValidTimeZone, normalizeVatNumber, OTHER_COUNTRY } from "@adminwise/core";
import { forCustomer, REPLY_DRAFT_MODES, system, type ReplyDraftMode } from "@adminwise/db";
import { redirect } from "next/navigation";
import { requireSession, signOut } from "@/lib/auth";
import { getAi, getConfig, getDb, getMailer, getStripe } from "@/lib/server";

const text = (value: FormDataEntryValue | null, max: number) =>
  (typeof value === "string" ? value : "").trim().slice(0, max);

export async function saveSettings(formData: FormData) {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);

  const languages = [
    ...new Set(
      text(formData.get("languages"), 100)
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter((code) => /^[a-z]{2}$/.test(code)),
    ),
  ];
  const timeZone = text(formData.get("timeZone"), 64);
  if (languages.length === 0) redirect("/settings?error=languages");
  if (!isValidTimeZone(timeZone)) redirect("/settings?error=timezone");
  const followUpDays = Number(text(formData.get("followUpDays"), 3));
  if (!Number.isInteger(followUpDays) || followUpDays < 1 || followUpDays > 30) redirect("/settings?error=followup");
  const replyDrafts = text(formData.get("replyDrafts"), 10) as ReplyDraftMode;
  if (!REPLY_DRAFT_MODES.includes(replyDrafts)) redirect("/settings?error=replydrafts");

  await scope.updateSettings({
    name: text(formData.get("name"), 200),
    languages,
    timeZone,
    signatureText: text(formData.get("signatureText"), 2000),
    followUpDays,
    replyDrafts,
  });
  await scope.audit("settings.updated", { languages, timeZone, followUpDays }, session.userId);
  redirect("/settings?saved=settings");
}

/**
 * Billing details for our own invoices. An EU VAT number is checked on every save: its shape
 * first, then the EU register (VIES), which gets the country code and the number and nothing else.
 */
export async function saveBilling(formData: FormData) {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);
  const billingCountry = text(formData.get("billingCountry"), 5).toUpperCase();
  if (!EU_COUNTRIES[billingCountry] && billingCountry !== OTHER_COUNTRY) redirect("/settings?error=billing_country#billing");
  const typed = text(formData.get("vatNumber"), 30);

  let vatNumber = typed;
  let vatStatus: "none" | "valid" | "invalid" | "unverified" = "none";
  let vatRegisteredName: string | null = null;
  if (typed && billingCountry !== OTHER_COUNTRY) {
    const normalized = normalizeVatNumber(billingCountry, typed);
    if (!normalized) redirect("/settings?error=vat_format#billing");
    vatNumber = normalized;
    ({ status: vatStatus, registeredName: vatRegisteredName } = await checkVatNumber(billingCountry, normalized));
  }
  await scope.updateBilling({
    billingName: text(formData.get("billingName"), 200),
    billingAddress: text(formData.get("billingAddress"), 500),
    billingCountry,
    vatNumber,
    vatStatus,
    vatCheckedAt: vatStatus === "valid" || vatStatus === "invalid" ? new Date() : null,
    vatRegisteredName,
  });
  await scope.audit("billing.updated", { billingCountry, vatStatus }, session.userId);
  redirect(`/settings?saved=billing_${vatStatus}#billing`);
}

/** Builds the voice profile from three pasted sent emails. The emails themselves are not stored. */
export async function generateVoiceProfile(formData: FormData) {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);
  // The same form is part of the "Getting started" guide.
  const page = formData.get("from") === "start" ? "/start" : "/settings";
  const samples = ["sample1", "sample2", "sample3"].map((name) => text(formData.get(name), 20_000));
  if (samples.some((s) => s.length < 40)) redirect(`${page}?error=samples#voice`);

  const customer = await scope.getCustomer();
  const runId = await scope.startJobRun("voice-profile");
  let ok = false;
  try {
    const { profile, usage } = await buildVoiceProfile(getAi(), { companyName: customer.name, samples });
    await scope.setVoiceProfile(profile);
    await scope.finishJobRun(runId, { status: "succeeded", ...usage });
    await scope.audit("voice_profile.generated", {}, session.userId);
    ok = true;
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "Unknown error";
    await scope.finishJobRun(runId, { status: "failed", error: reason });
  }
  redirect(ok ? `${page}?saved=voice#${page === "/start" ? "test" : "voice"}` : `${page}?error=ai#voice`);
}

export async function saveVoiceProfile(formData: FormData) {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);
  await scope.setVoiceProfile(text(formData.get("voiceProfile"), 4000));
  await scope.audit("voice_profile.edited", {}, session.userId);
  redirect("/settings?saved=voice#voice");
}

/** Choosing a plan: the customer is sent to Stripe's own payment page. Card details never reach us. */
export async function choosePlan(formData: FormData) {
  const session = await requireSession();
  const config = getConfig();
  const stripe = getStripe();
  const plan = text(formData.get("plan"), 10);
  const interval = text(formData.get("interval"), 10);
  if (!stripe || !config.billingEnabled) redirect("/settings?error=billing_off#plan");
  if ((plan !== "start" && plan !== "run") || (interval !== "month" && interval !== "year")) redirect("/settings?error=checkout#plan");

  const scope = forCustomer(getDb(), session.customerId);
  let url: string | null = null;
  try {
    let customer = await scope.getCustomer();
    // A running subscription is changed on Stripe's portal page, never by starting a second one.
    if (customer.billingStatus === "active" && customer.stripeSubscriptionId) {
      url = await stripe.createPortal({ stripeCustomerId: customer.stripeCustomerId!, returnUrl: `${config.appBaseUrl}/settings#plan` });
    } else {
      if (!customer.stripeCustomerId) {
        const created = await stripe.createCustomer({
          email: session.email,
          name: customer.billingName || customer.name,
          customerId: session.customerId,
        });
        await scope.setStripeCustomerId(created);
        customer = await scope.getCustomer();
      }
      url = await stripe.createCheckout({
        stripeCustomerId: customer.stripeCustomerId!,
        plan,
        interval,
        customerId: session.customerId,
        successUrl: `${config.appBaseUrl}/api/billing/return?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${config.appBaseUrl}/settings#plan`,
      });
      await scope.audit("billing.checkout_started", { plan, interval }, session.userId);
    }
  } catch (error) {
    console.error("[checkout]", error instanceof Error ? `${error.name}: ${error.message}` : "error");
  }
  redirect(url ?? "/settings?error=checkout#plan");
}

/** Stripe's own page for the card, invoices, switching plan and cancelling. */
export async function manageSubscription() {
  const session = await requireSession();
  const config = getConfig();
  const stripe = getStripe();
  const customer = await forCustomer(getDb(), session.customerId).getCustomer();
  if (!stripe || !customer.stripeCustomerId) redirect("/settings?error=checkout#plan");
  let url: string | null = null;
  try {
    url = await stripe.createPortal({ stripeCustomerId: customer.stripeCustomerId, returnUrl: `${config.appBaseUrl}/settings#plan` });
  } catch (error) {
    console.error("[portal]", error instanceof Error ? `${error.name}: ${error.message}` : "error");
  }
  redirect(url ?? "/settings?error=checkout#plan");
}

/**
 * Closes the account: deletes the customer and everything stored for them, at once.
 * Files in their own OneDrive and drafts in their own mailbox are theirs and stay.
 */
/**
 * Disconnects the Microsoft 365 mailbox: reading stops at once and our keys to it are removed.
 * Drafts and filed documents already in the customer's own mailbox and OneDrive stay there.
 */
export async function disconnectMailbox() {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);
  const connection = await scope.getConnectionByProvider("microsoft");
  if (connection && (await scope.disconnectConnection(connection.id))) {
    await scope.audit("mailbox.disconnected", { connectionId: connection.id }, session.userId);
  }
  redirect("/settings?saved=disconnected#mailbox");
}

export async function closeAccount(formData: FormData) {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);
  const customer = await scope.getCustomer();
  // A typed confirmation, so this cannot happen by a stray click.
  if (text(formData.get("confirm"), 20).toUpperCase() !== "DELETE") redirect("/settings?error=close_confirm#close");
  // A running subscription is ended at Stripe first, so nobody keeps paying for a deleted account.
  // Only a subscription that is still running: one that already ended has nothing to cancel.
  if (customer.stripeSubscriptionId && customer.billingStatus === "active") {
    const stripe = getStripe();
    let cancelled = false;
    try {
      if (stripe) {
        await stripe.cancelSubscription(customer.stripeSubscriptionId);
        cancelled = true;
      }
    } catch {
      // handled below
    }
    if (!cancelled) redirect("/settings?error=close_subscription#close");
  }

  const sys = system(getDb());
  const runId = await sys.startJobRun("account-closed");
  const to = await sys.listUserEmails(session.customerId);
  await sys.deleteCustomer(session.customerId);
  await sys.finishJobRun(runId, "succeeded");
  // Confirmation, to the addresses read before the deletion. A mail that fails must not undo anything.
  const { appName } = getConfig();
  await getMailer()
    .send({
      to,
      subject: `Your ${appName} account is closed`,
      textBody:
        `Your ${appName} account is closed, and everything we stored for it has been deleted: settings, price list, offers, tracked invoices and activity.\n\n` +
        "Files in your own OneDrive and drafts in your own mailbox are yours and were not touched. " +
        "Copies in our database backups disappear as those backups expire.\n",
    })
    .catch(() => undefined);
  await signOut();
  redirect("/signin?closed=1");
}

export async function signOutAction() {
  await signOut();
  redirect("/signin");
}
