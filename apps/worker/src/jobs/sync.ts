import { ConnectionUnavailableError, ingestInbound, QUEUES } from "@adminwise/core";
import { forCustomer, system } from "@adminwise/db";
import { GraphAuthError, GraphError } from "@adminwise/mail";
import { describeError, type Deps } from "../deps";

/** Every 5 minutes: queue a poll for each connected Microsoft 365 mailbox. */
export async function pollTick(deps: Deps): Promise<number> {
  const connections = await system(deps.db).listConnectionRefs("microsoft");
  for (const c of connections) {
    await deps.queue.send(QUEUES.syncMailbox, { customerId: c.customerId, connectionId: c.id });
  }
  return connections.length;
}

/**
 * Polling fallback for one mailbox: take in anything that arrived since the
 * last poll (a missed notification is caught here within 5 minutes), then keep
 * the notification subscription alive.
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
    await deps.outlook.ensureSubscription(scope, job.connectionId);
    await scope.finishJobRun(runId, { status: "succeeded" });
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
