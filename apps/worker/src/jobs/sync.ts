import { ConnectionUnavailableError, ingestInbound, ingestOutbound, QUEUES } from "@adminwise/core";
import { canFile, forCustomer, system } from "@adminwise/db";
import { GraphAuthError, GraphError } from "@adminwise/mail";
import { allowed, describeError, type Deps } from "../deps";

/** Attachments waiting for OneDrive are tried again at most this often. */
const FILING_RETRY_MINUTES = 30;

/** Mail that was stored but whose job never ran or never succeeded is handed to the worker again... */
const REDRIVE_AFTER_MINUTES = 20;
/** ...unless a run for it started this recently (the queue's own retries are up to 30 minutes apart), */
const REDRIVE_QUIET_MINUTES = 45;
/** ...or it has been tried this often. Its text is gone after 23 hours in any case. */
const REDRIVE_MAX_RUNS = 14;

/**
 * Every 5 minutes: queue a poll for each connected Microsoft 365 mailbox, and hand
 * mail that fell through (stored, but never handled) to the worker again.
 */
export async function pollTick(deps: Deps): Promise<number> {
  const sys = system(deps.db);
  const connections = await sys.listConnectionRefs("microsoft");
  for (const c of connections) {
    await deps.queue.send(QUEUES.syncMailbox, { customerId: c.customerId, connectionId: c.id });
  }
  const now = (deps.now?.() ?? new Date()).getTime();
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);
  const unhandled = await sys.listUnhandledMessages(
    minutesAgo(REDRIVE_AFTER_MINUTES),
    minutesAgo(22 * 60),
    minutesAgo(REDRIVE_QUIET_MINUTES),
    REDRIVE_MAX_RUNS,
  );
  for (const m of unhandled) await deps.queue.send(QUEUES.processMessage, m);
  return connections.length;
}

/**
 * Polling for one mailbox:
 *   - Inbox: take in anything that arrived since the last poll (a missed
 *     notification is caught here within 5 minutes),
 *   - Sent Items: note what the customer sent, so the chaser knows who wrote last,
 *   - try attachments again that were waiting for OneDrive,
 *   - keep the notification subscription alive.
 * The four steps do not depend on each other: one that fails is reported, and
 * the others still run. One message that cannot be read does not hold up the rest.
 */
export async function syncMailbox(deps: Deps, job: { customerId: string; connectionId: string }): Promise<number> {
  const scope = forCustomer(deps.db, job.customerId);
  // A read-only account (trial over, not paying): the mailbox is not read at all.
  if (!allowed(deps, await scope.getCustomer()).work) return 0;
  const runId = await scope.startJobRun("sync-mailbox", job.connectionId);
  let stored = 0;
  let firstFailure: unknown = null;
  /** A connection the customer must fix stops everything; any other failure only stops its own step. */
  const step = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) throw error;
      firstFailure ??= error;
    }
  };
  /** Moved or deleted between listing and reading: nothing to take in. */
  const gone = (error: unknown) => error instanceof GraphError && error.status === 404;

  try {
    await step(async () => {
      const { messageIds, deltaLink } = await deps.outlook.listNewMessageIds(scope, job.connectionId);
      let unread = 0;
      for (const id of messageIds) {
        try {
          const message = await deps.outlook.fetchMessage(scope, job.connectionId, id);
          if ((await ingestInbound(scope, deps.queue, job.connectionId, message)).stored) stored++;
        } catch (error) {
          if (gone(error)) continue;
          if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) throw error;
          unread++;
          firstFailure ??= error;
        }
      }
      // The bookmark only moves on when everything listed was taken in; otherwise the next poll
      // lists the same mail again (what was stored is recognised and skipped).
      if (unread === 0) await scope.markSynced(job.connectionId, deltaLink);
    });

    await step(async () => {
      const sent = await deps.outlook.listNewSentMessageIds(scope, job.connectionId);
      let unread = 0;
      for (const id of sent.messageIds) {
        try {
          await ingestOutbound(scope, job.connectionId, await deps.outlook.fetchMessage(scope, job.connectionId, id), deps.queue);
        } catch (error) {
          if (gone(error)) continue;
          if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) throw error;
          unread++;
          firstFailure ??= error;
        }
      }
      if (unread === 0) await scope.markSentSynced(job.connectionId, sent.deltaLink);
    });

    await step(async () => {
      const connection = await scope.getConnection(job.connectionId);
      if (!connection || !canFile(connection)) return;
      const now = deps.now?.() ?? new Date();
      const before = new Date(now.getTime() - FILING_RETRY_MINUTES * 60_000);
      for (const messageId of await scope.listQueuedFilingMessageIds(job.connectionId, before)) {
        await deps.queue.send(QUEUES.fileAttachments, { customerId: job.customerId, messageId });
      }
    });

    await step(() => deps.outlook.ensureSubscription(scope, job.connectionId));

    if (firstFailure) throw firstFailure;
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
  if (!allowed(deps, await scope.getCustomer()).work) return false;
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
