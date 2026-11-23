import { parseAmount } from "./money";

/**
 * Checking what the model read from an invoice against the invoice's own text.
 *
 * The model proposes the number, the amount and the dates. Nothing it says is
 * used unless that exact value can be found in the text of the PDF: a number
 * that is not printed on the invoice is dropped, and the owner is asked rather
 * than a guess being tracked or put in a reminder.
 */

export interface ProposedInvoice {
  number: string | null;
  /** As printed, for example "1 234,50" or "1234.50". */
  grossAmount: string | null;
  currency: string | null;
  /** YYYY-MM-DD */
  issueDate: string | null;
  dueDate: string | null;
  paymentTermDays: number | null;
  buyer: string | null;
}

export interface CheckedInvoice {
  number: string | null;
  amountCents: number | null;
  currency: string | null;
  issueDate: string | null;
  dueDate: string | null;
  buyer: string;
}

const squash = (value: string) => value.toLowerCase().replace(/\s+/g, " ");
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Is this amount printed in the text, with any usual grouping and decimal sign? "123450" matches "1 234,50" and "1,234.50". */
export function amountAppears(text: string, cents: number): boolean {
  const whole = String(Math.floor(cents / 100));
  const fraction = String(cents % 100).padStart(2, "0");
  // Digits of the whole part, with an optional group separator before every group of three.
  let pattern = "";
  for (let i = 0; i < whole.length; i++) {
    const fromEnd = whole.length - i;
    if (i > 0 && fromEnd % 3 === 0) pattern += "[ .,\\u00a0\\u202f']?";
    pattern += whole[i];
  }
  const decimals = fraction === "00" ? `(?:[.,]00)?` : `[.,]${fraction}`;
  return new RegExp(`(?<![\\d.,])${pattern}${decimals}(?![\\d]|[.,]\\d)`).test(text);
}

const isIsoDate = (value: string | null): value is string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Is this date printed in the text in a numeric form? 2026-11-30, 30.11.2026, 30-11-2026, 30/11/2026, 30.11.26. */
export function dateAppears(text: string, iso: string): boolean {
  const [year, month, day] = iso.split("-") as [string, string, string];
  const d = `0?${Number(day)}`;
  const m = `0?${Number(month)}`;
  const sep = "[.\\-/ ]";
  const forms = [
    `${year}${sep}${m}${sep}${d}`,
    `${d}${sep}${m}${sep}${year}`,
    `${d}${sep}${m}${sep}${year.slice(2)}`,
  ];
  return forms.some((form) => new RegExp(`(?<!\\d)${form}(?!\\d)`).test(text));
}

export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Keeps only what the invoice text confirms.
 * The due date is taken as printed; if only a payment term in days is printed
 * ("14 dni", "30 days") it is counted from the issue date, by code.
 */
export function checkInvoice(text: string, proposed: ProposedInvoice, fallbackCurrency: string): CheckedInvoice {
  const flat = squash(text);

  const number = proposed.number && proposed.number.trim().length >= 2 && flat.includes(squash(proposed.number.trim())) ? proposed.number.trim() : null;

  const cents = parseAmount(proposed.grossAmount);
  const amountCents = cents !== null && cents > 0 && amountAppears(text, cents) ? cents : null;

  const issueDate = isIsoDate(proposed.issueDate) && dateAppears(text, proposed.issueDate) ? proposed.issueDate : null;
  let dueDate = isIsoDate(proposed.dueDate) && dateAppears(text, proposed.dueDate) ? proposed.dueDate : null;
  const term = proposed.paymentTermDays;
  if (!dueDate && issueDate && term !== null && Number.isInteger(term) && term >= 0 && term <= 365) {
    // "14 dni", "30 days", "14 Tage", "30 dagen", "14 dnů": the number of days must be printed next to a word for days.
    const termPrinted = new RegExp(`(?<!\\d)${term}\\s*(dni|dzie[nń]|days?|tage?n?|dagen|dn[ůiy]|d\\b)`, "i").test(text);
    if (termPrinted) dueDate = addDaysIso(issueDate, term);
  }
  // A due date before the issue date is a misreading.
  if (dueDate && issueDate && dueDate < issueDate) dueDate = null;

  let currency = fallbackCurrency;
  const code = proposed.currency?.trim().toUpperCase() ?? "";
  if (/^[A-Z]{3}$/.test(code) && new RegExp(`(?<![A-Za-z])${escapeRegex(code)}(?![A-Za-z])`, "i").test(text)) currency = code;
  else if (/zł|zl\b/i.test(text)) currency = "PLN";
  else if (/€/.test(text)) currency = "EUR";

  const buyer = proposed.buyer && proposed.buyer.trim().length >= 2 && flat.includes(squash(proposed.buyer.trim())) ? proposed.buyer.trim().slice(0, 120) : "";

  return { number, amountCents, currency, issueDate, dueDate, buyer };
}

/** The steps of the reminder chain: days after the due date at which reminder 1, 2 and 3 are drafted. */
export const REMINDER_DAYS = [7, 14, 30] as const;
/** At least this many days between two reminders for the same invoice. */
export const MIN_DAYS_BETWEEN_REMINDERS = 7;

/** Whole days from one calendar date to another (positive when `to` is later). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Which reminder is due today for an invoice, or null. One level at a time:
 * an invoice that is already 40 days late when it is first seen gets reminder
 * 1 now, and the next ones a week apart, not three at once.
 */
export function reminderDue(invoice: { dueDate: string; remindersMade: number; lastReminderOn: string | null }, today: string): 1 | 2 | 3 | null {
  const next = invoice.remindersMade + 1;
  if (next > REMINDER_DAYS.length) return null;
  if (daysBetween(invoice.dueDate, today) < REMINDER_DAYS[next - 1]!) return null;
  if (invoice.lastReminderOn && daysBetween(invoice.lastReminderOn, today) < MIN_DAYS_BETWEEN_REMINDERS) return null;
  return next as 1 | 2 | 3;
}
