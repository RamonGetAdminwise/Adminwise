import { system } from "@adminwise/db";
import type { Deps } from "../deps";

/**
 * Every minute, through the queue: notes that the worker is alive. Because it
 * runs as a scheduled job, a fresh note proves three things at once: the worker
 * process runs, it reaches the database, and the queue hands out work.
 * No run is recorded for it: it would only fill the job log.
 */
export async function heartbeat(deps: Pick<Deps, "db" | "now">): Promise<void> {
  await system(deps.db).beat("worker", deps.now?.() ?? new Date());
}
