import { judgeStatus, QUEUE_BEHIND_AFTER_MINUTES, WORKER_SILENT_AFTER_MINUTES } from "@adminwise/core";
import { system, type Db } from "@adminwise/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heartbeat } from "../src/jobs/heartbeat";
import { openTestDb } from "./helpers";

/**
 * The alarm for "the worker itself has stopped": the worker notes every minute
 * that it is alive, and the status page an outside monitor calls says "not ok"
 * when that note is old.
 */

let db: Db;
beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await db.close();
});

const now = new Date("2026-11-24T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("is the service working, seen from outside", () => {
  it("is ok while the worker spoke recently and no job is waiting too long", () => {
    expect(judgeStatus({ databaseUp: true, workerLastBeat: minutesAgo(1), jobsBehind: 0, now })).toEqual({
      ok: true,
      checks: { database: "ok", worker: "ok", queue: "ok" },
    });
    // A worker restart during a deployment takes a minute or two: that is not an alarm.
    expect(judgeStatus({ databaseUp: true, workerLastBeat: minutesAgo(WORKER_SILENT_AFTER_MINUTES), jobsBehind: 0, now }).ok).toBe(true);
  });

  it("is not ok when the worker has gone silent, or never spoke", () => {
    expect(judgeStatus({ databaseUp: true, workerLastBeat: minutesAgo(WORKER_SILENT_AFTER_MINUTES + 1), jobsBehind: 0, now })).toEqual({
      ok: false,
      checks: { database: "ok", worker: "silent", queue: "ok" },
    });
    expect(judgeStatus({ databaseUp: true, workerLastBeat: null, jobsBehind: 0, now }).checks.worker).toBe("silent");
  });

  it("is not ok when jobs are waiting too long, even if the worker speaks", () => {
    expect(judgeStatus({ databaseUp: true, workerLastBeat: minutesAgo(0), jobsBehind: 3, now })).toEqual({
      ok: false,
      checks: { database: "ok", worker: "ok", queue: "behind" },
    });
    expect(QUEUE_BEHIND_AFTER_MINUTES).toBeGreaterThan(WORKER_SILENT_AFTER_MINUTES);
  });

  it("is not ok when the database cannot be reached, and claims nothing about the rest", () => {
    expect(judgeStatus({ databaseUp: false, workerLastBeat: null, jobsBehind: 0, now })).toEqual({
      ok: false,
      checks: { database: "down", worker: "unknown", queue: "unknown" },
    });
  });
});

describe("the worker's sign of life", () => {
  it("is one row that moves forward and never back", async () => {
    const sys = system(db);
    await heartbeat({ db, now: () => new Date("2030-01-01T10:00:00Z") });
    expect(await sys.lastBeat("worker")).toEqual(new Date("2030-01-01T10:00:00Z"));
    await heartbeat({ db, now: () => new Date("2030-01-01T10:01:00Z") });
    expect(await sys.lastBeat("worker")).toEqual(new Date("2030-01-01T10:01:00Z"));
    // A late note from an older moment does not turn the clock back.
    await heartbeat({ db, now: () => new Date("2030-01-01T09:00:00Z") });
    expect(await sys.lastBeat("worker")).toEqual(new Date("2030-01-01T10:01:00Z"));
    expect((await db.pool.query("SELECT count(*)::int AS n FROM heartbeats WHERE name = 'worker'")).rows[0].n).toBe(1);
    expect(await sys.lastBeat("nobody")).toBeNull();
  });
});
