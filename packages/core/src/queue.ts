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
  /** The owner confirmed an offer from the brief: make the order confirmation and a draft with it. */
  confirmOffer: "confirm-offer",
  /** Look at the PDFs attached to a mail the customer sent: is one of them an invoice of theirs to track? */
  trackInvoices: "track-invoices",
  /** Read one invoice whose text was taken from a forwarded PDF. */
  readInvoice: "read-invoice",
  /** Draft payment reminders for one customer's overdue invoices. */
  remindCustomer: "remind-customer",
  /** Hourly: trial reminders, trials that ended, and read-only accounts due for deletion. */
  billingTick: "billing-tick",
  /** Every minute: the worker notes that it is alive (read by the status page). */
  heartbeat: "worker-heartbeat",
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
  "confirm-offer": { customerId: string; offerId: string };
  "track-invoices": { customerId: string; messageId: string };
  "read-invoice": { customerId: string; invoiceId: string };
  "remind-customer": { customerId: string; localDate: string };
  "billing-tick": Record<string, never>;
  "worker-heartbeat": Record<string, never>;
}

/**
 * A failed job is tried again after about 30 s, 1, 2, 4, 8, 16 and then every 30 minutes:
 * ten tries spread over some two hours, so an outage at Microsoft, the model provider or
 * the mail service of an hour does not lose work. (Three tries within four minutes did.)
 */
const RETRY = { retryLimit: 9, retryDelay: 30, retryBackoff: true, retryDelayMax: 1800 };
/** The once-a-day jobs are started again by their scheduler, which waits longer after each failure. */
const DAILY_QUEUES = new Set<string>([QUEUES.sendBrief, QUEUES.chaseCustomer, QUEUES.remindCustomer]);

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
    const options = DAILY_QUEUES.has(name) ? { retryLimit: 0 } : RETRY;
    await boss.createQueue(name, options);
    // createQueue leaves a queue that already exists as it is: bring its settings up to date.
    await boss.updateQueue(name, options);
  }
  return {
    boss,
    async send(queue, data) {
      await boss.send(queue, data);
    },
    stop: () => boss.stop(),
  };
}
