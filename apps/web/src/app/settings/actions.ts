"use server";

import { buildVoiceProfile } from "@adminwise/ai";
import { isValidTimeZone } from "@adminwise/core";
import { forCustomer } from "@adminwise/db";
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

  await scope.updateSettings({
    name: text(formData.get("name"), 200),
    languages,
    timeZone,
    signatureText: text(formData.get("signatureText"), 2000),
  });
  await scope.audit("settings.updated", { languages, timeZone }, session.userId);
  redirect("/settings?saved=settings");
}

/** Builds the voice profile from three pasted sent emails. The emails themselves are not stored. */
export async function generateVoiceProfile(formData: FormData) {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);
  const samples = ["sample1", "sample2", "sample3"].map((name) => text(formData.get(name), 20_000));
  if (samples.some((s) => s.length < 40)) redirect("/settings?error=samples#voice");

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
  redirect(ok ? "/settings?saved=voice#voice" : "/settings?error=ai#voice");
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
