"use server";

import { buildVoiceProfile } from "@adminwise/ai";
import { checkVatNumber, EU_COUNTRIES, isValidTimeZone, normalizeVatNumber, OTHER_COUNTRY } from "@adminwise/core";
import { forCustomer, REPLY_DRAFT_MODES, type ReplyDraftMode } from "@adminwise/db";
import { redirect } from "next/navigation";
import { requireSession, signOut } from "@/lib/auth";
import { getAi, getDb } from "@/lib/server";

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

export async function signOutAction() {
  await signOut();
  redirect("/");
}
