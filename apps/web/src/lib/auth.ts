import "server-only";
import { randomBytes } from "node:crypto";
import { localClock } from "@adminwise/core";
import { forCustomer, sha256, system, type SessionInfo } from "@adminwise/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getConfig, getDb, getMailer } from "./server";

const SESSION_COOKIE = "aw_session";
const LINK_MINUTES = 15;
const SESSION_DAYS = 30;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254 ? email : null;
}

/** Emails a single-use sign-in link. Only the hash of the token is stored. */
export async function sendSignInLink(email: string): Promise<void> {
  const config = getConfig();
  const token = randomBytes(32).toString("base64url");
  await system(getDb()).createLoginToken(email, sha256(token), new Date(Date.now() + LINK_MINUTES * 60_000));
  const link = `${config.appBaseUrl}/auth/verify?token=${token}`;
  await getMailer().send({
    to: [email],
    subject: `Sign in to ${config.appName}`,
    textBody:
      `Open this link to sign in to ${config.appName}:\n\n${link}\n\n` +
      `It works once and expires in ${LINK_MINUTES} minutes. If you did not ask for it, ignore this email.\n`,
    devPrintBody: true,
  });
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "company"
  );
}

/**
 * Finishes sign-in: turns a valid link token into a session cookie. A first
 * sign-in also creates the customer and its forwarding address.
 */
export async function completeSignIn(token: string): Promise<boolean> {
  const sys = system(getDb());
  const email = await sys.consumeLoginToken(sha256(token));
  if (!email) return false;

  let user = await sys.findUserByEmail(email);
  if (!user) {
    const [local = "", domain = ""] = email.split("@");
    const base = slugify(domain.split(".")[0] && !/^(gmail|outlook|hotmail|yahoo|wp|o2|onet|interia)$/.test(domain.split(".")[0]!) ? domain.split(".")[0]! : local);
    let slug = base;
    while (await sys.slugExists(slug)) slug = `${base}-${randomBytes(2).toString("hex")}`;
    const timeZone = "Europe/Warsaw";
    const created = await sys.createCustomerWithUser({
      email,
      slug,
      timeZone,
      // The first daily brief is tomorrow's: there is no "yesterday" yet.
      briefStartDate: localClock(new Date(), timeZone).date,
    });
    user = { id: created.userId, customerId: created.customerId };
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await sys.createSession(user.id, user.customerId, sha256(sessionToken), expires);
  (await cookies()).set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: getConfig().appBaseUrl.startsWith("https://"),
    path: "/",
    expires,
  });
  return true;
}

export async function getSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return system(getDb()).findSession(sha256(token));
}

export async function requireSession(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) redirect("/");
  return session;
}

/** Where a signed-in person lands: the guide until they finished or skipped it, then settings. */
export async function landingPath(session: SessionInfo): Promise<"/start" | "/settings"> {
  const customer = await forCustomer(getDb(), session.customerId).getCustomer();
  return customer.setupFinishedAt ? "/settings" : "/start";
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await system(getDb()).deleteSession(sha256(token));
  jar.delete(SESSION_COOKIE);
}
