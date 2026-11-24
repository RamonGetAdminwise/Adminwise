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

/**
 * The months as words, January first: English, Dutch, German, Polish (also "8 grudnia") and Czech.
 * Each entry matches the full word and its usual short form ("Dec", "Dec.", "gru").
 */
const MONTH_WORDS = [
  "jan(?:uary|uari|uar)?|stycz(?:eń|nia)|sty|led(?:en|na)",
  "feb(?:ruary|ruari|ruar)?|lut(?:y|ego)?|únor(?:a)?",
  "mar(?:ch)?|maart|mrt|märz|mär|mar(?:zec|ca)|břez(?:en|na)",
  "apr(?:il)?|kwi(?:ecień|etnia)?|dub(?:en|na)",
  "may|mei|mai|maj(?:a)?|květ(?:en|na)",
  "june?|juni|cze(?:rwiec|rwca)?|červ(?:en|na)",
  "july?|juli|lip(?:iec|ca)?|červen(?:ec|ce)",
  "aug(?:ust|ustus)?|sie(?:rpień|rpnia)?|srp(?:en|na)",
  "sep(?:t|tember)?|wrz(?:esień|eśnia)?|září",
  "o[ck]t(?:ober)?|paź(?:dziernik|dziernika)?|říj(?:en|na)",
  "nov(?:ember)?|lis(?:topad|topada)?",
  "de[cz](?:ember)?|gru(?:dzień|dnia)?|prosin(?:ec|ce)",
];

/**
 * Is this date printed in the text? In numbers (2026-11-30, 30.11.2026, 30-11-2026, 30/11/2026,
 * 30.11.26) or with the month as a word ("30 November 2026", "30. November 2026",
 * "November 30, 2026", "30 listopada 2026", "30 Nov 2026").
 */
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
  if (forms.some((form) => new RegExp(`(?<!\\d)${form}(?!\\d)`).test(text))) return true;
  const word = `(?:${MONTH_WORDS[Number(month) - 1]})\\.?`;
  const edge = "(?![\\p{L}\\d])";
  const worded = [
    `(?<!\\d)${d}(?:st|nd|rd|th|\\.)?[ \\-]+${word}${edge}[ ,\\-]*${year}(?!\\d)`,
    `(?<![\\p{L}])${word}${edge} +${d}(?:st|nd|rd|th)?,? +${year}(?!\\d)`,
  ];
  return worded.some((form) => new RegExp(form, "iu").test(text));
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

/** Words in a company name that say what kind of company it is, not which one. */
const NOT_A_NAME = new Set([
  "sp", "zoo", "spolka", "sa", "sk", "sc", "ska", "ltd", "limited", "gmbh", "ag", "bv", "nv", "vof", "as", "ab", "oy", "aps", "inc", "llc",
  "sro", "co", "company", "phu", "pphu", "fhu", "puh", "firma", "przedsiebiorstwo", "zaklad", "uslugi", "uslugowe", "handel", "handlowe",
  "handlowo", "produkcyjno", "biuro", "group", "grupa", "holding", "polska", "poland", "international", "the", "and", "und", "van", "der",
]);

const plainLetters = (value: string) =>
  value
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ");

/**
 * Was the invoice mailed to the company it is made out to? Compared loosely: a distinctive
 * word of the buyer's name appears in the recipient's domain ("Rolmet sp. z o.o." and
 * rolmet.example), the domain name appears in the buyer's name, or the domain is the name's
 * initials. Returns null when there is nothing to compare (no buyer read, no domain, or a
 * mailbox provider such as gmail.com, where the domain says nothing).
 *
 * "false" is not a verdict, only a reason to ask the owner once: the invoice may have gone to
 * their accountant, or the buyer simply uses a domain unlike its name.
 */
export function recipientLooksLikeBuyer(buyerName: string, recipientDomain: string, isMailboxProvider: boolean): boolean | null {
  if (!buyerName.trim() || !recipientDomain.trim() || isMailboxProvider) return null;
  const labels = recipientDomain.toLowerCase().split(".").filter(Boolean);
  // Drop the country or type endings: "rolmet.com.pl" is about "rolmet".
  while (labels.length > 1 && (labels[labels.length - 1]!.length <= 3 || ["example", "info"].includes(labels[labels.length - 1]!))) labels.pop();
  const domain = plainLetters(labels.join(" ")).replace(/ /g, "");
  const words = plainLetters(buyerName).split(" ").filter((w) => w.length >= 2 && !NOT_A_NAME.has(w));
  if (domain.length < 3 || words.length === 0) return null;
  if (words.some((w) => w.length >= 4 && domain.includes(w))) return true;
  // The first letters of a long word are enough: "Tandartspraktijk Wit" and tandartswit.
  if (words.some((w) => w.length >= 6 && domain.includes(w.slice(0, 5)))) return true;
  if (words.join("").includes(domain)) return true;
  const initials = words.map((w) => w[0]).join("");
  return initials.length >= 2 && domain.startsWith(initials);
}
