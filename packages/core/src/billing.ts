/**
 * What an account may do, decided in one place.
 *
 * Rules (decisions log, 2026-11-23):
 *   - 14-day trial without a card, with everything the Run plan has.
 *   - After the trial, or when a paid subscription ends: read-only. Nothing new
 *     is read or prepared; settings and past activity stay visible.
 *   - Start: follow-ups, filing, daily brief, reply drafts.
 *     Run: also offers, order confirmations and payment reminders.
 *   - Our own accounts are "internal": everything, always.
 *   - While BILLING_ENABLED is not set, none of this applies and every account
 *     has everything. That is the switch for taking billing live.
 */
export const TRIAL_DAYS = 14;
/** The "your trial ends soon" mail goes out this many days before the end (day 12 of 14). */
export const TRIAL_REMINDER_DAYS_BEFORE = 2;
/** A read-only account is deleted after this many days... */
export const DELETE_AFTER_DAYS = 60;
/** ...and warned this many days before that. */
export const DELETE_WARNING_DAYS_BEFORE = 7;

export type Plan = "start" | "run";
export type BillingStatus = "trial" | "active" | "read_only" | "internal";

export interface BillingState {
  plan: Plan;
  billingStatus: BillingStatus;
  trialEndsAt: Date;
}

export interface Entitlements {
  /** May mail be read and anything new be prepared at all? */
  work: boolean;
  /** Offers and order confirmations from the price list. */
  offers: boolean;
  /** Tracking of sent invoices and payment reminders. */
  reminders: boolean;
}

const ALL: Entitlements = { work: true, offers: true, reminders: true };
const NONE: Entitlements = { work: false, offers: false, reminders: false };

export function entitlements(state: BillingState, now: Date, billingEnabled: boolean): Entitlements {
  if (!billingEnabled || state.billingStatus === "internal") return ALL;
  if (state.billingStatus === "read_only") return NONE;
  // A trial that has run out counts as read-only at once, also before the hourly job has noted it.
  if (state.billingStatus === "trial") return now < state.trialEndsAt ? ALL : NONE;
  return state.plan === "run" ? ALL : { work: true, offers: false, reminders: false };
}

const DAY_MS = 86_400_000;

/** Whole days left in the trial, never below zero ("2 days left" on the day-12 mail). */
export function trialDaysLeft(trialEndsAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS));
}

export const daysAfter = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);
