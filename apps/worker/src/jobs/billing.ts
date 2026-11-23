import {
  daysAfter,
  DELETE_AFTER_DAYS,
  DELETE_WARNING_DAYS_BEFORE,
  TRIAL_REMINDER_DAYS_BEFORE,
  trialDaysLeft,
} from "@adminwise/core";
import { system } from "@adminwise/db";
import { describeError, type Deps } from "../deps";

export interface BillingSweep {
  reminders: number;
  ended: number;
  warnings: number;
  deleted: number;
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Hourly, and only when billing is live:
 *   1. two days before a trial ends: one reminder mail,
 *   2. when a trial has ended without a subscription: the account becomes
 *      read-only and the owner is told,
 *   3. a week before a read-only account is deleted: one warning mail,
 *   4. 60 days read-only, and warned at least a week ago: the account and
 *      everything stored for it is deleted.
 * Each step marks the account in the same statement that selects it, so a mail
 * is never sent twice. Our own ("internal") and paying accounts are never touched.
 */
export async function billingTick(deps: Deps): Promise<BillingSweep | "off"> {
  if (!deps.billingEnabled) return "off";
  const sys = system(deps.db);
  const now = deps.now?.() ?? new Date();
  const runId = await sys.startJobRun("billing-sweep");
  const result: BillingSweep = { reminders: 0, ended: 0, warnings: 0, deleted: 0 };
  const plans = `${deps.appBaseUrl}/settings#plan`;
  const mail = async (customerId: string, subject: string, lines: string[]) => {
    const to = await sys.listUserEmails(customerId);
    if (to.length > 0) await deps.mailer.send({ to, subject, textBody: `${lines.join("\n")}\n` });
  };

  try {
    for (const c of await sys.claimTrialReminders(daysAfter(now, TRIAL_REMINDER_DAYS_BEFORE), now)) {
      const left = trialDaysLeft(c.trialEndsAt, now);
      await mail(c.id, `Your ${deps.appName} trial ends in ${left} ${left === 1 ? "day" : "days"}`, [
        `Your free trial of ${deps.appName} ends on ${day(c.trialEndsAt)}.`,
        "",
        "To keep your drafts, follow-ups, filing and daily brief running, choose a plan here:",
        plans,
        "",
        "If you do nothing, your account becomes read-only on that day: nothing new is prepared and your mailbox is no",
        "longer read. Your settings are kept, and choosing a plan later switches everything back on.",
      ]);
      result.reminders++;
    }

    for (const c of await sys.endExpiredTrials(now)) {
      await mail(c.id, `Your ${deps.appName} trial has ended`, [
        `Your free trial of ${deps.appName} has ended, so your account is now read-only.`,
        "",
        "Nothing new is prepared and your mailbox is no longer read. Your settings, price list and past activity are kept.",
        "",
        "Choose a plan to switch everything back on at once:",
        plans,
        "",
        `An account that stays read-only is deleted after ${DELETE_AFTER_DAYS} days. We will warn you a week before.`,
      ]);
      result.ended++;
    }

    const warnFrom = daysAfter(now, -(DELETE_AFTER_DAYS - DELETE_WARNING_DAYS_BEFORE));
    for (const c of await sys.claimDeletionWarnings(warnFrom, now)) {
      // Never earlier than a full week from this warning, also when the warning itself went out late.
      const deleteOn = new Date(
        Math.max(daysAfter(c.readOnlySince, DELETE_AFTER_DAYS).getTime(), daysAfter(now, DELETE_WARNING_DAYS_BEFORE).getTime()),
      );
      await mail(c.id, `Your ${deps.appName} account will be deleted on ${day(deleteOn)}`, [
        `Your ${deps.appName} account has been read-only since ${day(c.readOnlySince)}.`,
        "",
        `On ${day(deleteOn)} the account and everything we store for it will be deleted: settings, price list, offers,`,
        "tracked invoices and activity. Files in your own OneDrive and drafts in your own mailbox are yours and stay.",
        "",
        "To keep the account, choose a plan before that date:",
        plans,
      ]);
      result.warnings++;
    }

    const readOnlyBefore = daysAfter(now, -DELETE_AFTER_DAYS);
    const warnedBefore = daysAfter(now, -DELETE_WARNING_DAYS_BEFORE);
    for (const id of await sys.listAccountsToDelete(readOnlyBefore, warnedBefore)) {
      const to = await sys.listUserEmails(id);
      if (!(await sys.deleteCustomer(id, true))) continue;
      result.deleted++;
      // The addresses were read before the deletion; nothing of the account is left to look them up in.
      if (to.length > 0) {
        await deps.mailer.send({
          to,
          subject: `Your ${deps.appName} account has been deleted`,
          textBody:
            `Your ${deps.appName} account was read-only for ${DELETE_AFTER_DAYS} days and has now been deleted, with everything we stored for it.\n\n` +
            "Files in your own OneDrive and drafts in your own mailbox are yours and were not touched.\n\n" +
            `You are welcome back at any time: ${deps.appBaseUrl}\n`,
        });
      }
    }

    await sys.finishJobRun(runId, "succeeded");
    return result;
  } catch (error) {
    await sys.finishJobRun(runId, "failed", describeError(error));
    throw error;
  }
}
