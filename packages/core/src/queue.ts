import { PgBoss } from "pg-boss";

/** Every queue in the system, in one place. */
export const QUEUES = {
  /** Classify one stored message and, if it is business mail, draft a reply. */
  processMessage: "process-message",
  /** Fetch one message from Microsoft 365 after a change notification. */
  fetchGraphMessage: "fetch-graph-message",
  /** Poll one Microsoft 365 mailbox (fallback when a notification was missed). */
  syncMailbox: "sync-mailbox",
  /** Every 5 minutes: queue a sync for each connected mailbox. */
  pollTick: "poll-mailboxes",
  /** Hourly: empty email bodies older than the retention limit. */
  purgeBodies: "purge-bodies",
  /** Every minute: find customers whose local time has reached 07:30. */
  briefTick: "brief-tick",
  /** Build and send one customer's daily brief. */
  sendBrief: "send-daily-brief",
  /** Save the attachments of one stored message to the customer's OneDrive app folder. */
  fileAttachments: "file-attachments",
  /** Every minute: find customers whose local time has reached the nightly chaser scan. */
  chaseTick: "chase-tick",
  /** Find one customer's threads that went quiet and draft follow-ups. */
  chaseCustomer: "chase-customer",
  /** Hourly: email the operator a summary of failures, if there were any. */
  alertTick: "alert-tick",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  "process-message": { customerId: string; messageId: string };
  "fetch-graph-message": { customerId: string; connectionId: string; providerMessageId: string };
  "sync-mailbox": { customerId: string; connectionId: string };
  "poll-mailboxes": Record<string, never>;
  "purge-bodies": Record<string, never>;
  "brief-tick": Record<string, never>;
  "send-daily-brief": { customerId: string; localDate: string };
  "file-attachments": { customerId: string; messageId: string };
  "chase-tick": Record<string, never>;
  "chase-customer": { customerId: string; localDate: string };
  "alert-tick": Record<string, never>;
}

/** What the web app and jobs need: a way to hand work to the worker. */
export interface JobQueue {
  send<Q extends QueueName>(queue: Q, data: JobPayloads[Q]): Promise<void>;
}

export interface StartedQueue extends JobQueue {
  boss: PgBoss;
  stop(): Promise<void>;
}

/**
 * Starts pg-boss (the queue lives in Postgres, schema "pgboss").
 * role "web" only sends jobs; role "worker" also runs maintenance and schedules.
 */
export async function startQueue(connectionString: string, role: "web" | "worker"): Promise<StartedQueue> {
  const boss = new PgBoss({
    connectionString,
    supervise: role === "worker",
    schedule: role === "worker",
  });
  boss.on("error", (error) => console.error("[queue]", error.message));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name, { retryLimit: 3, retryDelay: 30, retryBackoff: true });
  }
  return {
    boss,
    async send(queue, data) {
      await boss.send(queue, data);
    },
    stop: () => boss.stop(),
  };
}
