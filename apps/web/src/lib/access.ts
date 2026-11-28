import "server-only";
import {
  signLinkToken,
  system,
  verifyLinkToken,
  type AccessRequest,
} from "@adminwise/db";
import { normalizeEmail } from "./auth";
import { ownerAddress, tell } from "./notify";
import { getConfig, getDb, getMailer } from "./server";

/**
 * How a new customer gets in. Nobody creates an account by themselves: they send a request from
 * the public site, the owner of the service gets it by mail and approves or declines, and only an
 * approved address can sign in for the first time. The requester hears back by mail either way.
 */

export const MAIL_SYSTEMS = {
  microsoft365: "Microsoft 365 / Outlook",
  gmail: "Gmail / Google Workspace",
  other: "Something else",
} as const;
export type MailSystem = keyof typeof MAIL_SYSTEMS;

/** No more than this many requests a day from everyone together: the form is public. */
const MAX_REQUESTS_PER_DAY = 40;
/** The owner has this long to decide from the mail; later the request is still there, the link is not. */
const DECIDE_LINK_DAYS = 30;

const clean = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";

export interface RequestInput {
  email: string;
  company: string;
  contactName: string;
  mailSystem: MailSystem;
  note: string | null;
}

/** Reads and checks the form. Returns the name of the first field that is wrong. */
export function readRequestForm(
  form: FormData,
):
  { input: RequestInput } | { error: "email" | "company" | "name" | "system" } {
  const email = normalizeEmail(form.get("email"));
  if (!email) return { error: "email" };
  const company = clean(form.get("company"), 120);
  if (company.length < 2) return { error: "company" };
  const contactName = clean(form.get("name"), 120);
  if (contactName.length < 2) return { error: "name" };
  const mailSystem = form.get("system");
  if (typeof mailSystem !== "string" || !(mailSystem in MAIL_SYSTEMS))
    return { error: "system" };
  // The note keeps its line breaks, within reason.
  const raw =
    typeof form.get("note") === "string" ? (form.get("note") as string) : "";
  const note =
    raw
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 1500) || null;
  return {
    input: {
      email,
      company,
      contactName,
      mailSystem: mailSystem as MailSystem,
      note,
    },
  };
}

/**
 * Takes in a request. The page answers the same whatever happens here, so the form cannot be used
 * to find out who is a customer. Returns "busy" only when the daily brake is on.
 */
export async function submitRequest(
  input: RequestInput,
): Promise<"ok" | "busy"> {
  const config = getConfig();
  const sys = system(getDb());

  // Already a customer: point them to the sign-in page and leave it at that.
  if (await sys.findUserByEmail(input.email)) {
    await tell(
      input.email,
      `You already have an account at ${config.appName}`,
      `Someone, probably you, asked for access to ${config.appName} with this address.\n\n` +
        `You already have an account. Sign in here:\n\n${config.appBaseUrl}/signin\n`,
    );
    return "ok";
  }

  if (
    (await sys.countAccessRequests(new Date(Date.now() - 24 * 3_600_000))) >=
    MAX_REQUESTS_PER_DAY
  )
    return "busy";

  const request = await sys.createAccessRequest(input);
  if (request.status === "approved") {
    // Asked again after being approved: send the way in once more.
    await sendApproved(input.email, input.contactName);
    return "ok";
  }
  if (!request.fresh) return "ok"; // already waiting: the owner knows, the requester was told

  const token = signLinkToken(
    { r: request.id },
    new Date(Date.now() + DECIDE_LINK_DAYS * 86_400_000),
    getDb().encryptionKey,
  );
  try {
    await getMailer().send({
      to: [ownerAddress()],
      subject: `Request for access: ${input.company}`,
      textBody:
        `A request for access to ${config.appName}.\n\n` +
        `Company:      ${input.company}\n` +
        `Name:         ${input.contactName}\n` +
        `Email:        ${input.email}\n` +
        `Mail system:  ${MAIL_SYSTEMS[input.mailSystem]}\n\n` +
        `What they want help with:\n${input.note ?? "(nothing written)"}\n\n` +
        `Approve or decline here (nothing happens until you press a button on that page):\n\n` +
        `${config.appBaseUrl}/request/decide?token=${token}\n\n` +
        `They were told they will hear from us within one working day.\n`,
      // Without a mail service (local development) the mail is printed, so the link can be followed.
      devPrintBody: true,
    });
  } catch {
    // The owner could not be told, so nobody would answer this request: say so instead of "thank you".
    return "busy";
  }
  await tell(
    input.email,
    `We received your request for ${config.appName}`,
    `Hello ${input.contactName},\n\n` +
      `Thank you for your interest in ${config.appName}. We received your request for ${input.company}.\n\n` +
      `A person reads every request. You will hear from us within one working day, at this address.\n\n` +
      `If you did not ask for this, ignore this email: nothing was created.\n\n` +
      `${config.appName}\n`,
  );
  return "ok";
}

async function sendApproved(
  email: string,
  contactName: string,
): Promise<boolean> {
  const config = getConfig();
  return tell(
    email,
    `Welcome to ${config.appName}: your request is approved`,
    `Hello ${contactName},\n\n` +
      `Your request is approved. This is how you start:\n\n` +
      `1. Open ${config.appBaseUrl}/signin\n` +
      `2. Enter this email address (${email}). There is no password: we mail you a link.\n` +
      `3. Open the link. A short guide takes you through the setup in about ten minutes.\n\n` +
      `${config.appName} only prepares drafts. Nothing is ever sent from your mailbox for you.\n\n` +
      `Questions? Just reply to this email.\n\n` +
      `${config.appName}\n`,
  );
}

/** The request a decide link points to, or null when the link is not ours, was changed or is too old. */
export async function requestOfLink(
  token: string,
): Promise<AccessRequest | null> {
  const payload = verifyLinkToken(token, getDb().encryptionKey);
  if (!payload?.r) return null;
  return system(getDb()).getAccessRequest(payload.r);
}

/**
 * Approves or declines, once, and tells the requester. Returns null for a link that is not ours,
 * else whether the mail to the requester went out (true too when it was decided before: nothing
 * is mailed twice).
 */
export async function decideRequest(
  token: string,
  decision: "approved" | "declined",
): Promise<{ told: boolean } | null> {
  const request = await requestOfLink(token);
  if (!request) return null;
  const decided = await system(getDb()).decideAccessRequest(
    request.id,
    decision,
  );
  if (!decided) return { told: true };
  const config = getConfig();
  if (decision === "approved") {
    return { told: await sendApproved(decided.email, decided.contactName) };
  }
  return {
    told: await tell(
      decided.email,
      `Your request for ${config.appName}`,
      `Hello ${decided.contactName},\n\n` +
        `Thank you for your interest in ${config.appName}. At the moment we cannot offer ${decided.company} a place.\n\n` +
        `If you think we missed something, reply to this email and tell us more about how you work.\n\n` +
        `${config.appName}\n`,
    ),
  };
}
