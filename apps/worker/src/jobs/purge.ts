import { system } from "@adminwise/db";
import { describeError, type Deps } from "../deps";

/**
 * Bodies must be gone within 24 hours. The job runs every hour and removes
 * anything older than 23 hours, so even a body stored just after a run is
 * removed before its 24th hour ends.
 */
export const BODY_RETENTION_HOURS = 23;
/** The record of what ran is kept this long (failed runs twice as long). */
export const JOB_RUN_RETENTION_DAYS = 90;

export async function purgeBodies(deps: Deps): Promise<{ messages: number; drafts: number }> {
  const sys = system(deps.db);
  const runId = await sys.startJobRun("purge-bodies");
  try {
    const now = deps.now?.() ?? new Date();
    const result = await sys.purgeBodies(BODY_RETENTION_HOURS, now);
    // Expired sign-in links and sessions, and old run records, go in the same hourly pass.
    await sys.prune(now, JOB_RUN_RETENTION_DAYS);
    await sys.finishJobRun(runId, "succeeded");
    return result;
  } catch (error) {
    await sys.finishJobRun(runId, "failed", describeError(error));
    throw error;
  }
}
