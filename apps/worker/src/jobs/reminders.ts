import { draftPaymentReminder } from "@adminwise/ai";
import { ConnectionUnavailableError, isWeekend, localClock } from "@adminwise/core";
import { forCustomer, type Customer, type CustomerScope, type Invoice } from "@adminwise/db";
import { GraphAuthError, GraphError } from "@adminwise/mail";
import { daysBetween, formatMoney, reminderDue } from "@adminwise/offers";
import { allowed, describeError, type Deps } from "../deps";
import { SYSTEM_SENDER } from "./prefilter";
import { appendSignature } from "./signature";

export interface RemindResult {
  status: "done" | "already_ran" | "weekend" | "not_in_plan";
  /** Reminder drafts written in this run. */
  reminders: number;
}

/** "26 372,43 PLN" for a Polish invoice, "26,372.43 PLN" otherwise. */
export function invoiceAmount(invoice: Pick<Invoice, "amountCents" | "currency" | "language">): string {
  return formatMoney(invoice.amountCents ?? 0, invoice.currency ?? "", invoice.language === "pl" ? "pl" : "en");
}

/**
 * Stops the reminders for an invoice (paid, or switched off by the owner) and
 * takes a reminder draft that is still waiting out of the Drafts folder.
 */
export async function endInvoiceChain(
  deps: Pick<Deps, "outlook">,
  scope: CustomerScope,
  invoice: Invoice,
  status: "paid" | "stopped",
  by: "owner" | "sender",
  at: Date,
): Promise<boolean> {
  const ended = await scope.endInvoice(invoice.id, status, by, at);
  if (!ended) return ended;
  const waiting = await scope.getOpenReminder(invoice.id);
  if (waiting) {
    await scope.closeDraft(waiting.id);
    if (waiting.providerDraftId && invoice.connectionId) {
      // If the mailbox cannot be reached the decision still stands; the draft is then left where it is.
      await deps.outlook.deleteDraft(scope, invoice.connectionId, waiting.providerDraftId).catch(() => undefined);
    }
  }
  return ended;
}

/**
 * Payment reminders for one customer, once per customer-local working day.
 *
 * For every tracked invoice that is past its due date: reminder 1 after 7
 * days, reminder 2 after 14, reminder 3 after 30, in rising tone, one at a
 * time and at least a week apart. The reminder is a draft:
 *   - invoice seen in the connected mailbox: a reply on the customer's own
 *     mail that carried the invoice, in their Drafts folder, addressed to the
 *     people that mail went to;
 *   - invoice forwarded to the Adminwise address: the text is emailed to the
 *     owner, who sends it themselves.
 * Nothing is sent to the debtor. An invoice marked paid, or one whose earlier
 * reminder draft is still waiting unsent, gets nothing.
 */
export async function remindCustomer(deps: Deps, job: { customerId: string; localDate: string }): Promise<RemindResult> {
  const scope = forCustomer(deps.db, job.customerId);
  // Payment reminders belong to the Run plan.
  if (!allowed(deps, await scope.getCustomer()).reminders) return { status: "not_in_plan", reminders: 0 };
  if (!(await scope.claimRemindForDate(job.localDate))) return { status: "already_ran", reminders: 0 };
  if (isWeekend(job.localDate)) return { status: "weekend", reminders: 0 };

  const now = deps.now?.() ?? new Date();
  const runId = await scope.startJobRun("payment-reminders", job.localDate);
  let inputTokens = 0;
  let outputTokens = 0;
  let reminders = 0;
  let firstFailure: unknown = null;

  try {
    const customer = await scope.getCustomer();
    for (const invoice of await scope.listOpenInvoices()) {
      const level = reminderDue(
        {
          dueDate: invoice.dueDate!,
          remindersMade: invoice.remindersMade,
          lastReminderOn: invoice.lastReminderAt ? localClock(invoice.lastReminderAt, customer.timeZone).date : null,
        },
        job.localDate,
      );
      if (!level || !invoice.messageId || !invoice.number || invoice.amountCents === null) continue;
      try {
        const made = await remindOne(deps, scope, customer, invoice, level, job.localDate, now);
        if (made) {
          inputTokens += made.inputTokens;
          outputTokens += made.outputTokens;
          reminders++;
        }
      } catch (error) {
        // One invoice failing must not keep the others from getting their reminder.
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
    await scope.finishJobRun(runId, { status: "succeeded", inputTokens, outputTokens, outcome: `reminders:${reminders}` });
    return { status: "done", reminders };
  } catch (error) {
    await scope.releaseRemindForDate(job.localDate);
    await scope.finishJobRun(runId, { status: "failed", inputTokens, outputTokens, error: describeError(error) });
    throw error;
  }
}

async function remindOne(
  deps: Deps,
  scope: CustomerScope,
  customer: Customer,
  invoice: Invoice,
  level: 1 | 2 | 3,
  localDate: string,
  now: Date,
): Promise<{ inputTokens: number; outputTokens: number } | null> {
  const message = await scope.getMessage(invoice.messageId!);
  if (!message) return null;
  const connection = invoice.connectionId ? await scope.getConnection(invoice.connectionId) : null;
  const toOutlook = invoice.source === "sent" && connection?.provider === "microsoft" && connection.status === "active";

  // An earlier reminder that is still sitting unsent: never put a second one next to it.
  const waiting = await scope.getOpenReminder(invoice.id);
  if (waiting) {
    try {
      if (toOutlook && waiting.providerDraftId && (await deps.outlook.isDraftWaiting(scope, connection!.id, waiting.providerDraftId))) {
        // The brief tells the owner that the next reminder waits for this one to leave the Drafts folder.
        await scope.markReminderBlocked(invoice.id, localDate);
        return null;
      }
    } catch (error) {
      if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) return null;
      throw error;
    }
    await scope.closeDraft(waiting.id);
  }

  // The people the invoice mail went to; read from the mailbox, since addresses are not kept here.
  let to: string[] = [];
  let cc: string[] = [];
  if (toOutlook) {
    try {
      const sent = await deps.outlook.fetchMessage(scope, connection!.id, message.providerMessageId);
      to = (sent.to ?? []).filter((a) => !SYSTEM_SENDER.test(a));
      cc = (sent.cc ?? []).filter((a) => !SYSTEM_SENDER.test(a));
    } catch (error) {
      if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) return null;
      if (!(error instanceof GraphError && error.status === 404)) throw error;
      // The mail is no longer in the mailbox: fall back to emailing the text to the owner.
    }
  }
  const asOutlookDraft = toOutlook && to.length > 0;

  const language = invoice.language ?? customer.languages[0] ?? "en";
  const draftId = await scope.claimDraft({
    messageId: message.id,
    threadId: message.threadId,
    destination: asOutlookDraft ? "outlook_drafts" : "email_to_customer",
    language,
    languageListed: true,
    kind: "reminder",
    seq: level,
    invoiceId: invoice.id,
  });
  if (!draftId) return null;

  try {
    const reminder = await draftPaymentReminder(deps.ai, {
      companyName: customer.name,
      voiceProfile: customer.voiceProfile,
      language,
      level,
      invoiceNumber: invoice.number!,
      amount: invoiceAmount(invoice),
      dueDate: invoice.dueDate!,
      daysOverdue: daysBetween(invoice.dueDate!, localDate),
    });
    const text = appendSignature(reminder.body, customer.signatureText);
    let providerDraftId: string | null = null;
    if (asOutlookDraft) {
      providerDraftId = await deps.outlook.createChaserDraft(scope, connection!.id, message.providerMessageId, text, to, cc);
    } else {
      const users = await scope.listUsers();
      const who = invoice.debtorName || invoice.debtorDomain || "your customer";
      await deps.mailer.send({
        to: users.map((u) => u.email),
        subject: `Payment reminder ${level} of 3: invoice ${invoice.number}`,
        textBody:
          `${deps.appName} prepared this payment reminder for invoice ${invoice.number} to ${who} ` +
          `(${invoiceAmount(invoice)}, due ${invoice.dueDate}). Nothing was sent: review it and send it yourself.\n\n` +
          `--------------------\n\n${text}\n`,
      });
    }
    await scope.completeDraft(draftId, text, providerDraftId, now);
    await scope.recordReminder(invoice.id, now);
    return { inputTokens: reminder.usage.inputTokens, outputTokens: reminder.usage.outputTokens };
  } catch (error) {
    await scope.failDraft(draftId, describeError(error));
    throw error;
  }
}
