import type { CustomerScope } from "@adminwise/db";
import { domainOf, type InboundMessage, isAutoReplySubject } from "@adminwise/mail";
import { QUEUES, type JobQueue } from "./queue";

/**
 * The single entry point for incoming mail, whichever way it arrived
 * (Graph notification, Graph polling, Postmark forwarding address).
 *
 * The same email delivered twice is stored once and queued once: the insert
 * returns nothing the second time, so nothing else happens.
 */
export async function ingestInbound(
  scope: CustomerScope,
  queue: JobQueue,
  connectionId: string | null,
  message: InboundMessage,
): Promise<{ stored: boolean; messageId: string | null }> {
  const stored = await scope.insertMessage({
    threadKey: message.threadKey,
    connectionId,
    dedupeKey: message.internetMessageId ?? `provider:${message.providerMessageId}`,
    providerMessageId: message.providerMessageId,
    direction: "inbound",
    senderDomain: domainOf(message.from.address),
    fromAddress: message.from.address,
    subject: message.subject,
    receivedAt: message.receivedAt,
    // An out-of-office known only from its subject line is automatic too: it must not count as
    // the other side's answer, or the follow-up for the unanswered question would never be drafted.
    headerFlags: isAutoReplySubject(message.subject) ? { ...message.headerFlags, autoSubmitted: true } : message.headerFlags,
    attachmentNames: message.attachmentNames,
    bodyText: message.bodyText,
  });
  if (!stored) return { stored: false, messageId: null };
  await queue.send(QUEUES.processMessage, { customerId: scope.customerId, messageId: stored.id });
  // Filing runs next to drafting; the job itself checks that a OneDrive is connected.
  if (connectionId && message.attachmentNames.length > 0) {
    await queue.send(QUEUES.fileAttachments, { customerId: scope.customerId, messageId: stored.id });
  }
  return { stored: true, messageId: stored.id };
}

/**
 * Mail the customer sent themselves (read from Sent Items). It is stored so
 * the chaser knows who wrote last; it never gets a draft and is never filed.
 * `senderDomain` holds the domain of the party it was sent to.
 */
export async function ingestOutbound(
  scope: CustomerScope,
  connectionId: string,
  message: InboundMessage,
  /** When given, a sent mail with attachments is also checked for an invoice to track. */
  queue?: JobQueue,
): Promise<{ stored: boolean; messageId: string | null }> {
  const stored = await scope.insertMessage({
    threadKey: message.threadKey,
    connectionId,
    dedupeKey: message.internetMessageId ?? `provider:${message.providerMessageId}`,
    providerMessageId: message.providerMessageId,
    direction: "outbound",
    senderDomain: domainOf(message.to?.[0] ?? ""),
    fromAddress: message.from.address,
    subject: message.subject,
    receivedAt: message.receivedAt,
    headerFlags: {},
    attachmentNames: message.attachmentNames,
    bodyText: message.bodyText,
  });
  if (stored && queue && message.attachmentNames.some((name) => /\.pdf$/i.test(name))) {
    await queue.send(QUEUES.trackInvoices, { customerId: scope.customerId, messageId: stored.id });
  }
  return { stored: Boolean(stored), messageId: stored?.id ?? null };
}
