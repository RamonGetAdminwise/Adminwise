"use server";

import { isValidTimeZone, setupTestMail, testMailWouldBeInternal } from "@adminwise/core";
import { forCustomer } from "@adminwise/db";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getConfig, getDb, getMailer } from "@/lib/server";

const PAGE = "/start";

const text = (value: FormDataEntryValue | null, max: number) =>
  (typeof value === "string" ? value : "").trim().slice(0, max);

/** Step 1: only what the first draft needs. Everything else keeps its value and is changed in settings. */
export async function saveCompany(formData: FormData) {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);
  const name = text(formData.get("name"), 200);
  const languages = [
    ...new Set(
      text(formData.get("languages"), 100)
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter((code) => /^[a-z]{2}$/.test(code)),
    ),
  ];
  const timeZone = text(formData.get("timeZone"), 64);
  if (!name) redirect(`${PAGE}?error=name`);
  if (languages.length === 0) redirect(`${PAGE}?error=languages`);
  if (!isValidTimeZone(timeZone)) redirect(`${PAGE}?error=timezone`);

  const customer = await scope.getCustomer();
  await scope.updateSettings({ name, languages, timeZone, signatureText: text(formData.get("signatureText"), 2000) || customer.signatureText });
  await scope.audit("settings.updated", { languages, timeZone, from: "setup" }, session.userId);
  redirect(`${PAGE}?saved=company#mailbox`);
}

/**
 * The guided test: one invented customer question, sent from our own address to
 * the owner's own mailbox (or, without a connected mailbox, to their sign-in
 * address so they can forward it). Nothing is sent from the customer's mailbox.
 */
export async function sendTestMail() {
  const session = await requireSession();
  const config = getConfig();
  const scope = forCustomer(getDb(), session.customerId);
  const [customer, connections, users] = await Promise.all([scope.getCustomer(), scope.listConnections(), scope.listUsers()]);
  const microsoft = connections.find((c) => c.provider === "microsoft" && c.status === "active");
  const own = [...users.map((u) => u.email), ...connections.map((c) => c.emailAddress)];
  if (testMailWouldBeInternal(config.mailFrom, own)) redirect(`${PAGE}?error=test_internal#test`);
  if (!(await scope.claimSetupTestMail(new Date()))) redirect(`${PAGE}?error=test_wait#test`);

  await getMailer().send({ to: [microsoft?.emailAddress ?? session.email], ...setupTestMail(customer.languages, config.appName) });
  await scope.audit("setup.test_mail_sent", { to: microsoft ? "mailbox" : "sign_in_address" }, session.userId);
  redirect(`${PAGE}?saved=test#test`);
}

/** "Finish" and "Skip for now" both end the guide; every step stays available in settings. */
export async function finishSetup() {
  const session = await requireSession();
  const scope = forCustomer(getDb(), session.customerId);
  await scope.finishSetup();
  await scope.audit("setup.finished", {}, session.userId);
  redirect("/settings");
}
