import "server-only";
import { getConfig, getMailer } from "./server";
import { contactEmail } from "./site";

/** Where the owner of the service reads requests and warnings: the alert address, else the public contact address. */
export function ownerAddress(): string {
  return getConfig().alertEmail ?? contactEmail();
}

/**
 * A mail to one person outside (a requester, a customer signing in). If it cannot be sent (a
 * mistyped address, a mailbox that refuses us, a mail service that refuses the address) the page
 * must not break, but it must not pass unnoticed either: with `warnOwner` the owner of the service
 * is told, because someone now waits for a mail that never comes. Returns whether the mail service
 * took the mail.
 */
export async function tell(
  to: string,
  subject: string,
  textBody: string,
  options: { warnOwner?: boolean; devPrintBody?: boolean } = {},
): Promise<boolean> {
  const { warnOwner = true, devPrintBody = false } = options;
  try {
    await getMailer().send({ to: [to], subject, textBody, ...(devPrintBody ? { devPrintBody: true } : {}) });
    return true;
  } catch (error) {
    if (!warnOwner) return false;
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
    try {
      // Only the subject is repeated, never the text: a sign-in mail carries its link in the text.
      await getMailer().send({
        to: [ownerAddress()],
        subject: `Not delivered: a mail to ${to}`,
        textBody:
          `${getConfig().appName} could not send this mail:\n\n` +
          `To:       ${to}\n` +
          `Subject:  ${subject}\n\n` +
          `What the mail service said:\n${reason}\n` +
          (reason.includes("(code 412)")
            ? `This code means the mail service has not yet approved our account for addresses outside our own domain.\n`
            : "") +
          `\n` +
          `They are waiting for it. Check the address, or write to them yourself.\n`,
      });
    } catch {
      // The owner cannot be reached either; the caller decides what the page says.
    }
    return false;
  }
}
