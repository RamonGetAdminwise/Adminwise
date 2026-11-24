import { judgeStatus, QUEUE_BEHIND_AFTER_MINUTES } from "@adminwise/core";
import { system } from "@adminwise/db";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * For an uptime monitor outside our own systems: answers 200 when the whole
 * service works and 503 when it does not (database down, worker stopped, or
 * the queue not being worked). Public, so it says one word per part and
 * nothing else.
 *
 * /api/health stays what the hosting platform uses to see that the web app
 * itself has started; it must not fail because the worker is down, or a new
 * version of the web app could not be deployed while the worker restarts.
 */
export async function GET() {
  const now = new Date();
  let status;
  try {
    const sys = system(getDb());
    const [workerLastBeat, queues] = await Promise.all([
      sys.lastBeat("worker"),
      sys.queueProblems(now, QUEUE_BEHIND_AFTER_MINUTES),
    ]);
    const jobsBehind = queues.reduce((sum, q) => sum + q.stuck, 0);
    status = judgeStatus({ databaseUp: true, workerLastBeat, jobsBehind, now });
  } catch {
    status = judgeStatus({ databaseUp: false, workerLastBeat: null, jobsBehind: 0, now });
  }
  return NextResponse.json(status, { status: status.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
