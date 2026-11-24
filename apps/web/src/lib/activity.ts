import type { JobRun } from "@adminwise/db";

const JOB_NAMES: Record<string, string> = {
  "reply-draft": "Incoming mail",
  "forwarding-intake": "Forwarding address",
  "sync-mailbox": "Mailbox check",
  "voice-profile": "Voice profile",
  "daily-brief": "Daily brief",
  chaser: "Follow-up check",
  filing: "Filing",
  "order-confirmation": "Order confirmation",
  "invoice-tracking": "Invoice check",
  "payment-reminders": "Payment reminders",
  "price-list-columns": "Price list upload",
  "offer-details": "Sample document",
};

const FILING_OUTCOMES: Record<string, string> = {
  no_drive: "Not filed: filing needs a connected Microsoft 365 account",
  filing_off: "Not filed: reconnect Microsoft 365 once to switch filing on",
  mailbox_disconnected: "Not filed: the mailbox needs to be reconnected",
  message_gone: "Not filed: the email is no longer in the mailbox",
  no_message: "Not filed: the email is no longer available",
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
  suspicious: "it contains text that tries to instruct an automated assistant; it is listed in your daily brief",
  switched_off: "reply drafts are switched off in your settings",
  not_selected: "it is not a quote request, an order or a payment reply, and you chose drafts for those only",
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
  if (run.status === "failed") return "Did not work. It is tried again by itself over the next hours; if it keeps failing, we are told";
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
    if (run.outcome === "read_only") return "Not handled: your account is read-only";
    if (run.status === "skipped") {
      return /purged|missing/.test(run.error ?? "") ? "Not handled: the email was no longer available" : "Skipped: already handled";
    }
  }
  if (run.job === "forwarding-intake") {
    if (run.outcome === "refused_sender:check_failed") {
      return "Refused: the email names one of your addresses as its sender, but the receiving mail server could not confirm it really came from there";
    }
    return "Refused: the sender is not on your list. Add the address under Mailbox, \"Who may send to this address\", exactly as it appears as sender";
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
    if (run.outcome === "not_in_plan") return "Not prepared: order confirmations are part of the Run plan";
    return "Skipped: the offer could not be found";
  }
  if (run.job === "payment-reminders") {
    const n = counts(run.outcome ?? "").reminders ?? 0;
    return n === 0 ? "No reminder is due today" : `${plural(n, "payment reminder", "payment reminders")} prepared as drafts`;
  }
  if (run.job === "invoice-tracking") {
    if (run.outcome === "not_in_plan") return "Not tracked: payment reminders are part of the Run plan";
    if (run.outcome === "no_mailbox") return "Skipped: the mailbox is not connected";
    if (run.outcome === "message_gone" || run.outcome === "no_message") return "Skipped: the email is no longer in the mailbox";
    if (run.status === "skipped" || run.outcome === "nothing_new") return "Nothing new to track";
    const c = counts(run.outcome ?? "");
    const parts = [];
    if (c.open) parts.push(`${plural(c.open, "invoice", "invoices")} now tracked for payment`);
    if (c.needs_confirm) parts.push(`${plural(c.needs_confirm, "invoice", "invoices")} sent to someone other than the buyer: you are asked in the brief`);
    if (c.needs_due_date) parts.push(`${plural(c.needs_due_date, "invoice", "invoices")} without a readable due date: you are asked in the brief`);
    if (c.unreadable) parts.push(`${plural(c.unreadable, "file", "files")} could not be read`);
    if (c.duplicate) parts.push(`${plural(c.duplicate, "invoice", "invoices")} already tracked`);
    return parts.length ? parts.join("; ") : "No invoice of yours in the attachments";
  }
  if (run.job === "offer-details") {
    if (run.outcome === "proposed") return "Your company details were read: confirm them on the offers page";
    if (run.outcome === "unreadable") return "The file could not be read (a scan or a photo?)";
    return "No company details found in the document";
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
      return parts.length ? parts.join("; ") : "No documents to file (only pictures, or files that are very small or too large)";
    }
  }
  return run.status === "succeeded" ? "Done" : "Skipped";
}
