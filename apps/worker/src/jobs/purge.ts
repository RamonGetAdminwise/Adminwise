import { system } from "@adminwise/db";
import { describeError, type Deps } from "../deps";

/**
 * Bodies must be gone within 24 hours. The job runs every hour and removes
 * anything older than 23 hours, so even a body stored just after a run is
 * removed before its 24th hour ends.
 */
export const BODY_RETENTION_HOURS = 23;

export async function purgeBodies(deps: Deps): Promise<{ messages: number; drafts: number }> {
  const sys = system(deps.db);
  const runId = await sys.startJobRun("purge-bodies");
  try {
    const result = await sys.purgeBodies(BODY_RETENTION_HOURS, deps.now?.() ?? new Date());
    await sys.finishJobRun(runId, "succeeded");
    return result;
  } catch (error) {
    await sys.finishJobRun(runId, "failed", describeError(error));
    throw error;
  }
}
