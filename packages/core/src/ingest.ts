import type { CustomerScope } from "@bo/db";
import { domainOf, type InboundMessage } from "@bo/mail";
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
    headerFlags: message.headerFlags,
    attachmentNames: message.attachmentNames,
    bodyText: message.bodyText,
  });
  if (!stored) return { stored: false, messageId: null };
  await queue.send(QUEUES.processMessage, { customerId: scope.customerId, messageId: stored.id });
  return { stored: true, messageId: stored.id };
}
