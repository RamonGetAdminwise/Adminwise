import { checkPaymentNotice, classifyMessage, draftReply } from "@adminwise/ai";
import { forCustomer } from "@adminwise/db";
import { allowed, describeError, type Deps } from "../deps";
import { ownDomains, prefilter } from "./prefilter";
import { prepareOrderConfirmation, prepareQuoteReply } from "./quote";
import { endInvoiceChain } from "./reminders";
import { appendSignature } from "./signature";

/** How many earlier messages of the thread the model sees as background. */
const HISTORY_LIMIT = 8;

export { appendSignature };

/**
 * The reply-draft job. For one stored inbound message:
 *   1. classify it (rules first, then the model),
 *   2. if it is business mail, write a draft in the customer's voice and the
 *      sender's language, append the signature,
 *   3. put the draft in the customer's Outlook Drafts folder, or email it back
 *      to the customer when the mail came through the forwarding address.
 * Nothing is ever sent to the outside sender. Safe to run twice for the same
 * message: the second run finds the draft already reserved and stops.
 */
export async function processMessage(
  deps: Deps,
  job: { customerId: string; messageId: string },
): Promise<"drafted" | "no_draft" | "skipped"> {
  const scope = forCustomer(deps.db, job.customerId);
  const runId = await scope.startJobRun("reply-draft", job.messageId);
  let inputTokens = 0;
  let outputTokens = 0;
  const finish = (
    status: "succeeded" | "failed" | "skipped",
    error: string | null = null,
    outcome: string | null = null,
  ) => scope.finishJobRun(runId, { status, inputTokens, outputTokens, error, outcome });

  try {
    const message = await scope.getMessage(job.messageId);
    if (!message || message.direction !== "inbound" || message.bodyText === null) {
      await finish("skipped", "message missing or already purged");
      return "skipped";
    }
    const customer = await scope.getCustomer();
    // Mail that was already taken in when the trial ended or the subscription stopped.
    const may = allowed(deps, customer);
    if (!may.work) {
      await finish("skipped", null, "read_only");
      return "skipped";
    }

    // 1. Classify (once: a retry reuses the stored answer).
    let classification = message.classification;
    let language = message.language;
    if (!classification) {
      const [users, connections] = await Promise.all([scope.listUsers(), scope.listConnections()]);
      const internal = ownDomains([...users.map((u) => u.email), ...connections.map((c) => c.emailAddress)]);
      classification = prefilter(message, internal);
      if (!classification) {
        const result = await classifyMessage(deps.ai, {
          companyName: customer.name,
          subject: message.subject,
          senderDomain: message.senderDomain,
          body: message.bodyText,
        });
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        classification = result.category;
        language = result.language;
      }
      await scope.setClassification(message.id, classification, language);
    }
    if (classification !== "business") {
      await finish("succeeded", null, `no_draft:${classification}`);
      return "no_draft";
    }

    // A reply in a conversation with an invoice we are chasing: does it say the invoice was paid?
    // If so the reminders stop, and the owner sees in the next brief that the sender said so.
    const chased = await scope.listOpenInvoicesForThread(message.threadId);
    if (chased.length > 0) {
      const notice = await checkPaymentNotice(deps.ai, {
        companyName: customer.name,
        invoiceNumbers: chased.map((i) => i.number ?? "").filter(Boolean),
        subject: message.subject,
        body: message.bodyText,
      });
      inputTokens += notice.usage.inputTokens;
      outputTokens += notice.usage.outputTokens;
      if (notice.paid) {
        const at = deps.now?.() ?? new Date();
        for (const invoice of chased) await endInvoiceChain(deps, scope, invoice, "paid", "sender", at);
      }
    }

    // The customer chose not to get reply drafts at all. Everything above still happened:
    // the mail is classified and a "we paid" stops reminders.
    if (customer.replyDrafts === "off") {
      await finish("succeeded", null, "no_draft:switched_off");
      return "no_draft";
    }

    // 2. Reserve the one draft this message may get.
    const connection = message.connectionId ? await scope.getConnection(message.connectionId) : null;
    const toOutlook = connection?.provider === "microsoft";
    const draftLanguage = language ?? customer.languages[0] ?? "en";
    const draftId = await scope.claimDraft({
      messageId: message.id,
      threadId: message.threadId,
      destination: toOutlook ? "outlook_drafts" : "email_to_customer",
      language: draftLanguage,
      languageListed: customer.languages.includes(draftLanguage),
    });
    if (!draftId) {
      await finish("skipped", "draft already exists");
      return "skipped";
    }

    let what: "drafted" | "offer" | "clarify" | "order" = "drafted";
    try {
      // 3. Write it. An acceptance of an open offer gets an order confirmation; a quote request (for
      //    customers with a price list) gets an offer; everything else an ordinary reply.
      const context = { customer, message, connection, language: draftLanguage };
      // Offers and order confirmations belong to the Run plan; on Start such mail gets an ordinary reply.
      const quote = may.offers
        ? ((await prepareOrderConfirmation(deps, scope, context)) ?? (await prepareQuoteReply(deps, scope, context)))
        : null;
      // "Sales mail only": a draft for quote requests, acceptances and replies about an invoice
      // being chased; any other business mail is left to the owner.
      if (customer.replyDrafts === "sales" && !quote && chased.length === 0) {
        await scope.releaseDraftClaim(draftId);
        await finish("succeeded", null, "no_draft:not_selected");
        return "no_draft";
      }
      let body: string;
      if (quote) {
        inputTokens += quote.inputTokens;
        outputTokens += quote.outputTokens;
        body = quote.body;
        what = quote.outcome;
      } else {
        const earlier = await scope.listThreadMessagesBefore(message.threadId, message.receivedAt, HISTORY_LIMIT);
        const draft = await draftReply(deps.ai, {
          companyName: customer.name,
          voiceProfile: customer.voiceProfile,
          language: draftLanguage,
          latest: { senderDomain: message.senderDomain, subject: message.subject, body: message.bodyText },
          history: earlier
            .filter((m) => m.bodyText)
            .map((m) => ({
              direction: m.direction,
              date: m.receivedAt.toISOString().slice(0, 10),
              body: m.bodyText!,
            })),
        });
        inputTokens += draft.usage.inputTokens;
        outputTokens += draft.usage.outputTokens;
        body = draft.body;
      }
      const text = appendSignature(body, customer.signatureText);
      const attachments = quote?.attachments ?? [];

      // 4. Deliver it to the customer. Never to the outside sender.
      let providerDraftId: string | null = null;
      if (toOutlook) {
        providerDraftId = await deps.outlook.createReplyDraft(
          scope,
          connection!.id,
          message.providerMessageId,
          text,
          attachments,
        );
      } else {
        const users = await scope.listUsers();
        await deps.mailer.send({
          to: users.map((u) => u.email),
          subject: `Draft reply: ${message.subject}`,
          textBody:
            `${deps.appName} prepared this draft reply to the email from ${message.senderDomain}. ` +
            (attachments.length
              ? `${what === "order" ? "The order confirmation" : "The offer"} is attached: send it along with your reply. `
              : "") +
            "Nothing was sent: review it and paste it into your reply.\n\n" +
            `--------------------\n\n${text}\n`,
          attachments,
        });
      }
      await scope.completeDraft(draftId, text, providerDraftId);
    } catch (error) {
      await scope.failDraft(draftId, describeError(error));
      throw error;
    }

    await finish("succeeded", null, `${what}:${toOutlook ? "outlook" : "email"}`);
    return "drafted";
  } catch (error) {
    await finish("failed", describeError(error));
    throw error;
  }
}
