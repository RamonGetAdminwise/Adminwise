import {
  daysAfter,
  DELETE_AFTER_DAYS,
  DELETE_WARNING_DAYS_BEFORE,
  TRIAL_DAYS,
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
 * Each account is marked only after its mail has gone out: a mail that fails is
 * tried again next hour, and one account's failure does not hold up the others.
 * Nobody is deleted who was not warned. Our own ("internal") and paying
 * accounts are never touched.
 *
 * While billing is off, the only thing done is to keep every trial's full
 * length ahead of it, so that switching billing on cuts nobody off.
 */
export async function billingTick(deps: Deps): Promise<BillingSweep | "off"> {
  const sys = system(deps.db);
  const now = deps.now?.() ?? new Date();
  if (!deps.billingEnabled) {
    await sys.holdTrialClocks(now, TRIAL_DAYS);
    return "off";
  }
  const runId = await sys.startJobRun("billing-sweep");
  const result: BillingSweep = { reminders: 0, ended: 0, warnings: 0, deleted: 0 };
  const plans = `${deps.appBaseUrl}/settings#plan`;
  const mail = async (customerId: string, subject: string, lines: string[]) => {
    const to = await sys.listUserEmails(customerId);
    if (to.length > 0) await deps.mailer.send({ to, subject, textBody: `${lines.join("\n")}\n` });
  };

  let firstFailure: unknown = null;
  /** One account's step; a failure is remembered and the next account still gets its turn. */
  const each = async <T>(accounts: T[], step: (account: T) => Promise<void>) => {
    for (const account of accounts) {
      try {
        await step(account);
      } catch (error) {
        firstFailure ??= error;
      }
    }
  };

  try {
    await each(await sys.listTrialReminders(daysAfter(now, TRIAL_REMINDER_DAYS_BEFORE), now), async (c) => {
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
      await sys.markTrialReminderSent(c.id, now);
      result.reminders++;
    });

    await each(await sys.listExpiredTrials(now), async (c) => {
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
      if (await sys.endTrial(c.id, now)) result.ended++;
    });

    const warnFrom = daysAfter(now, -(DELETE_AFTER_DAYS - DELETE_WARNING_DAYS_BEFORE));
    await each(await sys.listDeletionWarnings(warnFrom), async (c) => {
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
      await sys.markDeletionWarned(c.id, now);
      result.warnings++;
    });

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

    if (firstFailure) throw firstFailure;
    await sys.finishJobRun(runId, "succeeded");
    return result;
  } catch (error) {
    await sys.finishJobRun(runId, "failed", describeError(error));
    throw error;
  }
}
