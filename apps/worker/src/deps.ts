import type { AiClient } from "@adminwise/ai";
import { entitlements, type BillingState, type Entitlements, type JobQueue, type OutlookGateway } from "@adminwise/core";
import type { Db } from "@adminwise/db";
import type { OutboundMailer } from "@adminwise/mail";

export interface PdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

/**
 * Everything a job needs from the outside world. Production wires in the real
 * services (main.ts); tests wire in fakes, so the same job code runs in both.
 */
export interface Deps {
  db: Db;
  queue: JobQueue;
  ai: AiClient;
  mailer: OutboundMailer;
  outlook: OutlookGateway;
  /** Prints an HTML page to PDF (offers, order confirmations). */
  pdf: PdfRenderer;
  appName: string;
  appBaseUrl: string;
  /** Where operator alerts go; unset = no alerts. */
  alertEmail?: string | null;
  /** False or unset: every account has every feature (billing not live yet). */
  billingEnabled?: boolean;
  now?: () => Date;
}

/** What this account may do right now: see packages/core/src/billing.ts. */
export function allowed(deps: Deps, customer: BillingState): Entitlements {
  return entitlements(customer, deps.now?.() ?? new Date(), deps.billingEnabled ?? false);
}

/** A short technical reason for the job log. Built from our own error messages, never from email content. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return "Unknown error";
}

/** A once-a-day job (follow-ups, reminders, brief) that failed is tried again at most this often on one day. */
export const DAILY_MAX_TRIES = 5;
const DAILY_FIRST_WAIT_MS = 5 * 60_000;

/**
 * May a once-a-day job that failed earlier today run again now? The wait doubles
 * after each failure (5, 10, 20, 40 minutes) and after five failures it is left
 * for the day: the operator has been told by then. Without this a job that fails
 * every time was started again every minute, with a model call each time.
 */
export function mayTryAgain(failed: { count: number; last: Date } | undefined, now: Date): boolean {
  if (!failed) return true;
  if (failed.count >= DAILY_MAX_TRIES) return false;
  return now.getTime() - failed.last.getTime() >= DAILY_FIRST_WAIT_MS * 2 ** (failed.count - 1);
}
