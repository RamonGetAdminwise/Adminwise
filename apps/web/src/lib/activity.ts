import type { JobRun } from "@adminwise/db";

const JOB_NAMES: Record<string, string> = {
  "reply-draft": "Incoming mail",
  "sync-mailbox": "Mailbox check",
  "voice-profile": "Voice profile",
  "daily-brief": "Daily brief",
};

const NO_DRAFT_REASONS: Record<string, string> = {
  internal: "it came from your own company",
  newsletter: "it is a newsletter or mailing list",
  notification: "it is an automatic notification",
  auto_reply: "it is an automatic reply",
};

export function jobName(run: Pick<JobRun, "job">): string {
  return JOB_NAMES[run.job] ?? run.job;
}

/** What a job run did, in the customer's words. Built from fixed codes only, never from mail content. */
export function describeRun(run: Pick<JobRun, "job" | "status" | "outcome" | "error">): string {
  if (run.status === "running") return "In progress";
  if (run.status === "failed") return "Failed; it will be tried again";
  const [code, detail] = (run.outcome ?? "").split(":");

  if (run.job === "reply-draft") {
    if (code === "drafted") {
      return detail === "email" ? "Draft written and emailed to you" : "Draft written, in your Outlook Drafts folder";
    }
    if (code === "no_draft") {
      const reason = NO_DRAFT_REASONS[detail ?? ""] ?? "it is not a business email that needs a reply";
      return `No draft needed: ${reason}`;
    }
    if (run.status === "skipped") return "Skipped: already handled";
  }
  if (run.job === "sync-mailbox") {
    if (run.status === "skipped") return "Skipped: the mailbox needs to be reconnected";
    if (code === "new_mail") {
      const count = Number(detail);
      return count === 0 ? "No new mail" : `${count} new ${count === 1 ? "email" : "emails"} taken in`;
    }
  }
  return run.status === "succeeded" ? "Done" : "Skipped";
}
