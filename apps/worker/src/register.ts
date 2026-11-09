import { QUEUES, type JobPayloads, type QueueName } from "@bo/core";
import type { PgBoss } from "pg-boss";
import type { Deps } from "./deps";
import { briefTick, sendBrief } from "./jobs/brief";
import { processMessage } from "./jobs/process-message";
import { purgeBodies } from "./jobs/purge";
import { fetchGraphMessage, pollTick, syncMailbox } from "./jobs/sync";

/** Connects each queue to the job that handles it. */
export async function registerWorkers(boss: PgBoss, deps: Deps, concurrency: number): Promise<void> {
  async function on<Q extends QueueName>(
    queue: Q,
    localConcurrency: number,
    handler: (data: JobPayloads[Q]) => Promise<unknown>,
  ) {
    // Mail queues are checked twice a second so a burst drains quickly; ticks can wait the default 2 s.
    const pollingIntervalSeconds = localConcurrency > 1 ? 0.5 : 2;
    await boss.work<JobPayloads[Q]>(queue, { localConcurrency, pollingIntervalSeconds }, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }

  await on(QUEUES.processMessage, concurrency, (data) => processMessage(deps, data));
  await on(QUEUES.fetchGraphMessage, concurrency, (data) => fetchGraphMessage(deps, data));
  await on(QUEUES.syncMailbox, concurrency, (data) => syncMailbox(deps, data));
  await on(QUEUES.sendBrief, 2, (data) => sendBrief(deps, data));
  await on(QUEUES.pollTick, 1, () => pollTick(deps));
  await on(QUEUES.purgeBodies, 1, () => purgeBodies(deps));
  await on(QUEUES.briefTick, 1, () => briefTick(deps));
}

/** The recurring schedules (stored in Postgres by pg-boss; one worker fires each tick). */
export async function registerSchedules(boss: PgBoss): Promise<void> {
  await boss.schedule(QUEUES.pollTick, "*/5 * * * *");
  await boss.schedule(QUEUES.purgeBodies, "7 * * * *");
  await boss.schedule(QUEUES.briefTick, "* * * * *");
}
