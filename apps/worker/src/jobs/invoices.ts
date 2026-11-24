import { createHash } from "node:crypto";
import { readInvoiceFields } from "@adminwise/ai";
import { ConnectionUnavailableError } from "@adminwise/core";
import { forCustomer, type Customer, type CustomerScope, type InvoiceStatus } from "@adminwise/db";
import { GraphAuthError, GraphError, type AttachmentInfo } from "@adminwise/mail";
import { checkInvoice, extractPdfText, offerStrings } from "@adminwise/offers";
import { allowed, describeError, type Deps } from "../deps";

/** PDFs outside these sizes are not invoices worth reading (icons, or scans of whole folders). */
const MIN_PDF_BYTES = 2 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** At most this many PDFs of one mail are looked at. */
const MAX_PDFS_PER_MAIL = 3;

const isPdf = (a: AttachmentInfo) => !a.isInline && (/\.pdf$/i.test(a.name) || a.contentType === "application/pdf");

/** Our own documents (offers, order confirmations) are attached to the customer's sent mail too; they are not invoices. */
function isOwnDocument(name: string): boolean {
  return ["en", "pl"].some((language) => {
    const t = offerStrings(language);
    return [t.offer, t.orderConfirmation].some((title) => name.startsWith(`${title.replace(/\s+/g, "_")}_`));
  });
}

/**
 * Reads one noted PDF: is it an invoice the customer issued, and what are its
 * number, amount and due date? The model proposes; only values printed in the
 * PDF's text are kept (checkInvoice). The outcome is one of:
 *   open            tracked; reminders follow after the due date
 *   needs_due_date  no due date could be read: the owner is asked in the brief
 *   unreadable      no text (a scan), or no number or amount could be confirmed
 *   not_ours        not an invoice, or not one the customer issued
 *   duplicate       the same invoice number is already tracked
 * The text is used here and not kept.
 */
export async function readInvoice(
  deps: Deps,
  scope: CustomerScope,
  customer: Customer,
  invoiceId: string,
  text: string | null,
): Promise<{ status: InvoiceStatus; inputTokens: number; outputTokens: number }> {
  if (!text) {
    await scope.setInvoiceRead(invoiceId, { status: "unreadable" });
    return { status: "unreadable", inputTokens: 0, outputTokens: 0 };
  }
  const { reading, usage } = await readInvoiceFields(deps.ai, {
    companyName: customer.name,
    companyDetails: customer.companyDetails,
    text,
  });
  const done = async (status: InvoiceStatus, fields: Parameters<CustomerScope["setInvoiceRead"]>[1] = { status }) => {
    await scope.setInvoiceRead(invoiceId, { ...fields, status });
    return { status, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  };
  if (!reading.isInvoice || !reading.issuedByCompany) return done("not_ours");

  const checked = checkInvoice(text, reading, customer.currency);
  if (!checked.number || checked.amountCents === null) return done("unreadable");
  if (await scope.findInvoiceByNumber(checked.number, invoiceId)) return done("duplicate");

  return done(checked.dueDate ? "open" : "needs_due_date", {
    status: "open",
    number: checked.number,
    language: reading.language,
    debtorName: checked.buyer,
    amountCents: checked.amountCents,
    currency: checked.currency,
    issueDate: checked.issueDate,
    dueDate: checked.dueDate,
  });
}

/**
 * For a mail the customer sent from their connected mailbox: looks at its PDF
 * attachments and starts tracking any that is an invoice of theirs.
 * Safe to run twice: a file that was already read (same content) is skipped;
 * one that was noted but not read, because the first attempt failed, is read.
 */
export async function trackSentInvoices(deps: Deps, job: { customerId: string; messageId: string }): Promise<string> {
  const scope = forCustomer(deps.db, job.customerId);
  const runId = await scope.startJobRun("invoice-tracking", job.messageId);
  let inputTokens = 0;
  let outputTokens = 0;
  const finish = async (outcome: string, status: "succeeded" | "skipped" = "succeeded") => {
    await scope.finishJobRun(runId, { status, inputTokens, outputTokens, outcome });
    return outcome;
  };
  try {
    // Invoice tracking belongs to the Run plan.
    if (!allowed(deps, await scope.getCustomer()).reminders) return await finish("not_in_plan", "skipped");
    const message = await scope.getMessage(job.messageId);
    if (!message || message.direction !== "outbound" || !message.connectionId) return await finish("no_message", "skipped");
    const connection = await scope.getConnection(message.connectionId);
    if (!connection || connection.provider !== "microsoft" || connection.status !== "active") {
      return await finish("no_mailbox", "skipped");
    }
    let attachments: AttachmentInfo[];
    try {
      attachments = await deps.outlook.listAttachments(scope, connection.id, message.providerMessageId);
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return await finish("message_gone", "skipped");
      throw error;
    }
    const pdfs = attachments
      .filter((a) => isPdf(a) && a.sizeBytes >= MIN_PDF_BYTES && a.sizeBytes <= MAX_PDF_BYTES && !isOwnDocument(a.name))
      .slice(0, MAX_PDFS_PER_MAIL);

    const customer = await scope.getCustomer();
    const counts: Record<string, number> = {};
    for (const attachment of pdfs) {
      const content = await deps.outlook.downloadAttachment(scope, connection.id, message.providerMessageId, attachment.id);
      const contentHash = createHash("sha256").update(content).digest("hex");
      let invoiceId = await scope.createInvoice({
        source: "sent",
        messageId: message.id,
        threadId: message.threadId,
        connectionId: connection.id,
        fileName: attachment.name,
        contentHash,
        // For sent mail the message row holds the domain it was sent to.
        debtorDomain: message.senderDomain,
      });
      if (!invoiceId) {
        // The file is already known. If an earlier attempt noted it but failed before reading it,
        // it is read now; anything else was dealt with before.
        const known = await scope.getInvoiceByHash(contentHash);
        if (known?.status !== "pending" || known.source !== "sent") continue;
        invoiceId = known.id;
      }
      const result = await readInvoice(deps, scope, customer, invoiceId, await extractPdfText(content));
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      counts[result.status] = (counts[result.status] ?? 0) + 1;
    }
    const summary = Object.entries(counts).map(([status, n]) => `${status}:${n}`).join(",");
    return await finish(summary || "nothing_new");
  } catch (error) {
    if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) {
      await scope.finishJobRun(runId, { status: "skipped", inputTokens, outputTokens, error: describeError(error) });
      return "no_mailbox";
    }
    await scope.finishJobRun(runId, { status: "failed", inputTokens, outputTokens, error: describeError(error) });
    throw error;
  }
}

/**
 * For an invoice the customer forwarded to their Adminwise address: the web
 * app took the text out of the PDF and noted the invoice as pending; this
 * reads it. The text is removed from the record in the same step.
 */
export async function readForwardedInvoice(deps: Deps, job: { customerId: string; invoiceId: string }): Promise<string> {
  const scope = forCustomer(deps.db, job.customerId);
  const runId = await scope.startJobRun("invoice-tracking", job.invoiceId);
  try {
    const invoice = await scope.getInvoice(job.invoiceId);
    if (!allowed(deps, await scope.getCustomer()).reminders) {
      await scope.finishJobRun(runId, { status: "skipped", outcome: "not_in_plan" });
      return "not_in_plan";
    }
    if (!invoice || invoice.status !== "pending") {
      await scope.finishJobRun(runId, { status: "skipped", outcome: "nothing_new" });
      return "nothing_new";
    }
    const result = await readInvoice(deps, scope, await scope.getCustomer(), invoice.id, invoice.pendingText);
    await scope.finishJobRun(runId, {
      status: "succeeded",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      outcome: `${result.status}:1`,
    });
    return result.status;
  } catch (error) {
    await scope.finishJobRun(runId, { status: "failed", error: describeError(error) });
    throw error;
  }
}
