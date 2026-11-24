/**
 * Is the service working, as seen from outside? Decided here in one place and
 * shown by the status page (/api/status), which an outside uptime monitor calls
 * every few minutes. It exists because the worker's own alert mail cannot warn
 * about the one thing that matters most: the worker itself having stopped.
 */

/** The worker notes that it is alive every minute. This long without a note means it has stopped. */
export const WORKER_SILENT_AFTER_MINUTES = 5;
/** A job that should have started this long ago and has not means the queue is not being worked. */
export const QUEUE_BEHIND_AFTER_MINUTES = 20;

export interface ServiceStatus {
  ok: boolean;
  /** One word per part, never any detail: this page is public. */
  checks: { database: "ok" | "down"; worker: "ok" | "silent" | "unknown"; queue: "ok" | "behind" | "unknown" };
}

export function judgeStatus(seen: {
  /** False when the database could not be reached; the other two are then unknown. */
  databaseUp: boolean;
  /** When the worker last said it was alive; null when it never did. */
  workerLastBeat: Date | null;
  /** Jobs waiting longer than QUEUE_BEHIND_AFTER_MINUTES. */
  jobsBehind: number;
  now: Date;
}): ServiceStatus {
  if (!seen.databaseUp) return { ok: false, checks: { database: "down", worker: "unknown", queue: "unknown" } };
  const silentFor = seen.workerLastBeat ? seen.now.getTime() - seen.workerLastBeat.getTime() : Infinity;
  const worker = silentFor <= WORKER_SILENT_AFTER_MINUTES * 60_000 ? "ok" : "silent";
  const queue = seen.jobsBehind > 0 ? "behind" : "ok";
  return { ok: worker === "ok" && queue === "ok", checks: { database: "ok", worker, queue } };
}
