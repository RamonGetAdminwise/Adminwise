import { ConnectionUnavailableError, ingestInbound, ingestOutbound, QUEUES } from "@adminwise/core";
import { canFile, forCustomer, system } from "@adminwise/db";
import { GraphAuthError, GraphError } from "@adminwise/mail";
import { describeError, type Deps } from "../deps";

/** Attachments waiting for OneDrive are tried again at most this often. */
const FILING_RETRY_MINUTES = 30;

/** Every 5 minutes: queue a poll for each connected Microsoft 365 mailbox. */
export async function pollTick(deps: Deps): Promise<number> {
  const connections = await system(deps.db).listConnectionRefs("microsoft");
  for (const c of connections) {
    await deps.queue.send(QUEUES.syncMailbox, { customerId: c.customerId, connectionId: c.id });
  }
  return connections.length;
}

/**
 * Polling for one mailbox:
 *   - Inbox: take in anything that arrived since the last poll (a missed
 *     notification is caught here within 5 minutes),
 *   - Sent Items: note what the customer sent, so the chaser knows who wrote last,
 *   - try attachments again that were waiting for OneDrive,
 *   - keep the notification subscription alive.
 */
export async function syncMailbox(deps: Deps, job: { customerId: string; connectionId: string }): Promise<number> {
  const scope = forCustomer(deps.db, job.customerId);
  const runId = await scope.startJobRun("sync-mailbox", job.connectionId);
  try {
    const { messageIds, deltaLink } = await deps.outlook.listNewMessageIds(scope, job.connectionId);
    let stored = 0;
    for (const id of messageIds) {
      const message = await deps.outlook.fetchMessage(scope, job.connectionId, id);
      if ((await ingestInbound(scope, deps.queue, job.connectionId, message)).stored) stored++;
    }
    await scope.markSynced(job.connectionId, deltaLink);

    const sent = await deps.outlook.listNewSentMessageIds(scope, job.connectionId);
    for (const id of sent.messageIds) {
      try {
        await ingestOutbound(scope, job.connectionId, await deps.outlook.fetchMessage(scope, job.connectionId, id));
      } catch (error) {
        // Moved or deleted between listing and reading: nothing to note.
        if (!(error instanceof GraphError && error.status === 404)) throw error;
      }
    }
    await scope.markSentSynced(job.connectionId, sent.deltaLink);

    const connection = await scope.getConnection(job.connectionId);
    if (connection && canFile(connection)) {
      const now = deps.now?.() ?? new Date();
      const before = new Date(now.getTime() - FILING_RETRY_MINUTES * 60_000);
      for (const messageId of await scope.listQueuedFilingMessageIds(job.connectionId, before)) {
        await deps.queue.send(QUEUES.fileAttachments, { customerId: job.customerId, messageId });
      }
    }

    await deps.outlook.ensureSubscription(scope, job.connectionId);
    await scope.finishJobRun(runId, { status: "succeeded", outcome: `new_mail:${stored}` });
    return stored;
  } catch (error) {
    // A connection the customer must fix is not an error to retry: its status
    // is already set and the daily brief will show the reconnect link.
    if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) {
      await scope.finishJobRun(runId, { status: "skipped", error: describeError(error) });
      return 0;
    }
    await scope.finishJobRun(runId, { status: "failed", error: describeError(error) });
    throw error;
  }
}

/** A Graph change notification said "this message arrived": fetch it and take it in. */
export async function fetchGraphMessage(
  deps: Deps,
  job: { customerId: string; connectionId: string; providerMessageId: string },
): Promise<boolean> {
  const scope = forCustomer(deps.db, job.customerId);
  try {
    const message = await deps.outlook.fetchMessage(scope, job.connectionId, job.providerMessageId);
    return (await ingestInbound(scope, deps.queue, job.connectionId, message)).stored;
  } catch (error) {
    if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) return false;
    // Moved or deleted before we got to it: nothing to do.
    if (error instanceof GraphError && error.status === 404) return false;
    throw error;
  }
}
