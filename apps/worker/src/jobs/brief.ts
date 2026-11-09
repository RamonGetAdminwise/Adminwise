import { addDays, localClock, QUEUES, startOfLocalDay } from "@bo/core";
import { forCustomer, system, type DraftSummary, type MailboxConnection } from "@bo/db";
import { describeError, type Deps } from "../deps";

/** 07:30 in the customer's own time zone. */
export const BRIEF_MINUTE_OF_DAY = 7 * 60 + 30;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", pl: "Polish", de: "German", cs: "Czech", nl: "Dutch", fr: "French", es: "Spanish", it: "Italian",
  sk: "Slovak", uk: "Ukrainian", hu: "Hungarian", ro: "Romanian",
};

/**
 * Runs every minute. Queues a brief for each customer whose local clock has
 * reached 07:30 and who has not had today's brief yet.
 */
export async function briefTick(deps: Deps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let queued = 0;
  for (const customer of await system(deps.db).listCustomerClocks()) {
    const clock = localClock(now, customer.timeZone);
    if (clock.minutesOfDay < BRIEF_MINUTE_OF_DAY) continue;
    if (customer.briefLastSentOn && customer.briefLastSentOn >= clock.date) continue;
    await deps.queue.send(QUEUES.sendBrief, { customerId: customer.id, localDate: clock.date });
    queued++;
  }
  return queued;
}

/** The brief's text. Sections with nothing in them are left out. */
export function composeBrief(input: {
  appName: string;
  appBaseUrl: string;
  localDate: string;
  drafts: DraftSummary[];
  problems: Pick<MailboxConnection, "provider" | "emailAddress" | "status">[];
}): { subject: string; textBody: string } {
  const subject = `Your daily brief - ${input.localDate}`;
  if (input.drafts.length === 0 && input.problems.length === 0) {
    return { subject, textBody: `Nothing needed your attention yesterday. ${input.appName} is running.\n` };
  }

  const sections: string[] = [];
  if (input.drafts.length > 0) {
    const lines = input.drafts.map((d) => {
      const where = d.destination === "outlook_drafts" ? "in your Outlook Drafts" : "emailed to you";
      const flag = d.languageListed
        ? ""
        : ` [written in ${LANGUAGE_NAMES[d.language ?? ""] ?? d.language}, a language not on your list: please check it]`;
      return `- "${d.subject}" (from ${d.senderDomain}) - ${where}${flag}`;
    });
    sections.push(`DRAFTS PREPARED YESTERDAY (${input.drafts.length})\n${lines.join("\n")}`);
  }
  if (input.problems.length > 0) {
    const lines = input.problems.map(
      (p) =>
        `- Your Microsoft 365 mailbox ${p.emailAddress} is disconnected, so new mail is not being read. ` +
        `Reconnect it here: ${input.appBaseUrl}/settings`,
    );
    sections.push(`CONNECTION PROBLEMS\n${lines.join("\n")}`);
  }
  return { subject, textBody: `Good morning,\n\n${sections.join("\n\n")}\n\n${input.appName}\n` };
}

/** Builds and sends one customer's brief for a local date. Sends at most once per date. */
export async function sendBrief(
  deps: Deps,
  job: { customerId: string; localDate: string },
): Promise<"sent" | "already_sent"> {
  const scope = forCustomer(deps.db, job.customerId);
  if (!(await scope.claimBriefForDate(job.localDate))) return "already_sent";

  const runId = await scope.startJobRun("daily-brief", job.localDate);
  try {
    const customer = await scope.getCustomer();
    const from = startOfLocalDay(addDays(job.localDate, -1), customer.timeZone);
    const to = startOfLocalDay(job.localDate, customer.timeZone);
    const [drafts, connections, users] = await Promise.all([
      scope.listDraftSummaries(from, to),
      scope.listConnections(),
      scope.listUsers(),
    ]);
    const brief = composeBrief({
      appName: deps.appName,
      appBaseUrl: deps.appBaseUrl,
      localDate: job.localDate,
      drafts,
      problems: connections.filter((c) => c.status === "needs_reconnect" || c.status === "revoked"),
    });
    await deps.mailer.send({ to: users.map((u) => u.email), ...brief });
    await scope.finishJobRun(runId, { status: "succeeded" });
    return "sent";
  } catch (error) {
    await scope.releaseBriefForDate(job.localDate);
    await scope.finishJobRun(runId, { status: "failed", error: describeError(error) });
    throw error;
  }
}
