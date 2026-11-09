import type { Classification, Message } from "@bo/db";

/** Mailbox providers where "same domain" says nothing about being a colleague. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me",
  "protonmail.com", "wp.pl", "o2.pl", "onet.pl", "interia.pl", "op.pl", "gazeta.pl", "ziggo.nl", "kpnmail.nl",
  "gmx.de", "web.de", "seznam.cz",
]);

const AUTO_REPLY_SUBJECT =
  /^\s*(automatic reply|auto(matic)?[- ]?reply|out of office|autoodpowied[zź]|odpowied[zź] automatyczna|poza biurem|abwesenheit|automatische antwort|afwezig|automatisch antwoord)/i;
const SYSTEM_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply|mailer-daemon|postmaster|notifications?|alerts?|bounce)[^@]*@/i;

/** Domains that count as "inside the company": taken from the customer's own addresses. */
export function ownDomains(addresses: string[]): Set<string> {
  const domains = addresses.map((a) => a.split("@")[1]?.toLowerCase() ?? "").filter((d) => d && !FREE_MAIL.has(d));
  return new Set(domains);
}

/**
 * Sorts out the mail that needs no AI: anything a machine sent says so in its
 * headers or sender address, and colleagues share the customer's domain.
 * Returns null when a person outside the company may have written the mail;
 * only then is the model asked.
 */
export function prefilter(message: Message, internalDomains: Set<string>): Classification | null {
  if (message.headerFlags.autoSubmitted || AUTO_REPLY_SUBJECT.test(message.subject)) return "auto_reply";
  if (message.headerFlags.list || message.headerFlags.bulk) return "newsletter";
  if (message.fromAddress && SYSTEM_SENDER.test(message.fromAddress)) return "notification";
  if (message.senderDomain && internalDomains.has(message.senderDomain)) return "internal";
  return null;
}
