import "server-only";
import { getConfig } from "./server";

/**
 * Facts the public site states in more than one place. Prices and the trial
 * length were confirmed on 2026-11-09; the plan contents on 2026-11-23.
 * The site must only promise what the product does today.
 */
export const TRIAL_DAYS = 14;

export interface Plan {
  name: string;
  tagline: string;
  monthly: number;
  yearly: number;
  highlighted: boolean;
  intro: string;
  features: string[];
}

export const PLANS: Plan[] = [
  {
    name: "Start",
    tagline: "Stop losing things",
    monthly: 19,
    yearly: 190,
    highlighted: false,
    intro: "For the owner whose inbox is the to-do list.",
    features: [
      "Follow-up drafts when a customer goes quiet",
      "Invoices, orders and contracts filed to your OneDrive",
      "Daily brief at 07:30: what needs you today",
      "Reply drafts in your own tone, for the mail you choose",
      "1 user, 1 mailbox",
    ],
  },
  {
    name: "Run",
    tagline: "Get paid and get your evenings back",
    monthly: 49,
    yearly: 490,
    highlighted: true,
    intro: "Everything in Start, plus the paperwork that brings money in.",
    features: [
      "Offers as PDF from your own price list, with your logo",
      "Order confirmations when a customer accepts",
      "Discounts per customer, applied by rule",
      "Payment reminders 7, 14 and 30 days after the due date",
      "Money due and overdue in your daily brief",
    ],
  },
];

/** The address people write to, taken from our sending address ("Adminwise <hello@...>"). */
export function contactEmail(): string {
  const from = getConfig().mailFrom;
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

/** Where "Start free" and "Sign in" lead: the app, which may live on another host than the site. */
export function signInUrl(): string {
  return `${getConfig().appBaseUrl}/signin`;
}
