import { system } from "@adminwise/db";
import { describeError, type Deps } from "../deps";

/** A job that should have started this long ago and has not means the queue is stuck. */
const STUCK_MINUTES = 15;
const WINDOW_MS = 3_600_000;

/**
 * Hourly: one email to the operator of the service when something went wrong
 * in the past hour (job crashes, model or Microsoft errors, a stuck queue).
 * Nothing is sent when nothing went wrong.
 *
 * The mail holds customer ids, job names, error types and counts only. It
 * never holds email text, subjects, addresses or file names. Problems the
 * customer has to fix themselves (reconnect a mailbox, OneDrive not reachable)
 * are not in here: those go to the customer's daily brief and Settings page.
 */
export async function sendOperatorAlert(deps: Deps): Promise<"sent" | "nothing" | "off"> {
  if (!deps.alertEmail) return "off";
  const sys = system(deps.db);
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - WINDOW_MS);
  const runId = await sys.startJobRun("operator-alert");
  try {
    const [failures, queues] = await Promise.all([sys.failureSummary(since), sys.queueProblems(since, STUCK_MINUTES)]);
    if (failures.length === 0 && queues.length === 0) {
      await sys.finishJobRun(runId, "succeeded");
      return "nothing";
    }

    const total = failures.reduce((sum, f) => sum + f.count, 0);
    const lines: string[] = [
      `${deps.appName} operator alert for the hour up to ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      "",
    ];
    if (failures.length > 0) {
      lines.push(`FAILED JOBS (${total})`);
      for (const f of failures) {
        lines.push(`- ${f.count} x ${f.job}: ${f.errorType} (customer ${f.customerId ?? "none, system job"})`);
      }
      lines.push("");
    }
    if (queues.length > 0) {
      lines.push("QUEUE");
      for (const q of queues) {
        if (q.stuck > 0) lines.push(`- ${q.queue}: ${q.stuck} job(s) waiting more than ${STUCK_MINUTES} minutes`);
        if (q.failed > 0) lines.push(`- ${q.queue}: ${q.failed} job(s) gave up after all retries`);
      }
      lines.push("");
    }
    lines.push("Details are in the job log (table job_runs) and the worker log. This mail never contains email content.");

    await deps.mailer.send({
      to: [deps.alertEmail],
      subject: `[${deps.appName}] ${total} failed job(s)${queues.length > 0 ? ", queue needs a look" : ""}`,
      textBody: `${lines.join("\n")}\n`,
    });
    await sys.finishJobRun(runId, "succeeded");
    return "sent";
  } catch (error) {
    await sys.finishJobRun(runId, "failed", describeError(error));
    throw error;
  }
}
