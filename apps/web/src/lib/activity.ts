import type { JobRun } from "@adminwise/db";

const JOB_NAMES: Record<string, string> = {
  "reply-draft": "Incoming mail",
  "sync-mailbox": "Mailbox check",
  "voice-profile": "Voice profile",
  "daily-brief": "Daily brief",
  chaser: "Follow-up check",
  filing: "Filing",
  "order-confirmation": "Order confirmation",
  "price-list-columns": "Price list upload",
};

const FILING_OUTCOMES: Record<string, string> = {
  no_drive: "Not filed: filing needs a connected Microsoft 365 account",
  filing_off: "Not filed: reconnect Microsoft 365 once to switch filing on",
  mailbox_disconnected: "Not filed: the mailbox needs to be reconnected",
  message_gone: "Not filed: the email is no longer in the mailbox",
  "not_filed:internal": "Not filed: it came from your own company",
  "not_filed:newsletter": "Not filed: it is a newsletter or mailing list",
  "not_filed:auto_reply": "Not filed: it is an automatic reply",
};

/** "filed:2,duplicate:1,queued:0" -> { filed: 2, duplicate: 1, queued: 0 } */
function counts(outcome: string): Record<string, number> {
  return Object.fromEntries(outcome.split(",").map((part) => [part.split(":")[0], Number(part.split(":")[1])]));
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
    if (code === "offer") {
      return detail === "email" ? "Offer prepared and emailed to you with the draft" : "Offer prepared, attached to the draft in your Outlook Drafts folder";
    }
    if (code === "clarify") {
      return "Quote request: the draft asks the sender for details, no offer yet";
    }
    if (code === "order") {
      return detail === "email" ? "Offer accepted: order confirmation emailed to you with the draft" : "Offer accepted: order confirmation attached to the draft in your Outlook Drafts folder";
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
  if (run.job === "order-confirmation") {
    if (code === "order") return detail === "email" ? "Order confirmation emailed to you" : "Order confirmation attached to a draft in your Outlook Drafts folder";
    if (run.outcome === "already_confirmed") return "This offer already had its order confirmation";
    return "Skipped: the offer could not be found";
  }
  if (run.job === "price-list-columns") {
    return run.outcome === "columns_found" ? "Columns of your price list recognised" : "Columns not recognised: choose them on the price list page";
  }
  if (run.job === "chaser") {
    if (run.outcome === "no_mailbox" || run.status === "skipped") return "Skipped: no connected Microsoft 365 mailbox";
    if (code === "chasers") {
      const c = counts(run.outcome ?? "");
      if (!c.chasers && !c.listed) return "No conversation needs a follow-up";
      const parts = [];
      if (c.chasers) parts.push(`${plural(c.chasers, "follow-up draft", "follow-up drafts")} in your Outlook Drafts`);
      if (c.listed) parts.push(`${plural(c.listed, "conversation", "conversations")} quiet after two follow-ups`);
      return parts.join("; ");
    }
  }
  if (run.job === "filing") {
    const fixed = FILING_OUTCOMES[run.outcome ?? ""];
    if (fixed) return fixed;
    if (code === "filed") {
      const c = counts(run.outcome ?? "");
      const parts = [];
      if (c.filed) parts.push(`${plural(c.filed, "document", "documents")} saved to OneDrive`);
      if (c.duplicate) parts.push(`${plural(c.duplicate, "file", "files")} already filed earlier`);
      if (c.queued) parts.push(`${plural(c.queued, "file", "files")} waiting: OneDrive could not be reached`);
      return parts.length ? parts.join("; ") : "No documents to file (only pictures or small files)";
    }
  }
  return run.status === "succeeded" ? "Done" : "Skipped";
}
