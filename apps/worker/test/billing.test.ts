import { entitlements, ingestInbound, trialDaysLeft } from "@adminwise/core";
import { system, type Db } from "@adminwise/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingTick } from "../src/jobs/billing";
import { briefTick } from "../src/jobs/brief";
import { chaseTick } from "../src/jobs/chaser";
import { trackSentInvoices } from "../src/jobs/invoices";
import { remindCustomer } from "../src/jobs/reminders";
import { fetchGraphMessage, syncMailbox } from "../src/jobs/sync";
import { createNordpart, giveNordpartPriceList, makeWorld, openTestDb, quoteFixture, toInbound } from "./helpers";

let db: Db;
beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await db.close();
});

type Nordpart = Awaited<ReturnType<typeof createNordpart>>;
const at = (iso: string) => () => new Date(iso);

/**
 * These tests live in January 2020: the hourly sweep looks at every account in the
 * shared test database, and every other test's account has a trial that ends
 * long after that, so nothing but the accounts made here is ever touched.
 */
const TRIAL_END = "2020-01-15T00:00:00Z";

async function setBilling(nordpart: Nordpart, fields: { status?: string; plan?: string; trialEndsAt?: string }) {
  await db.pool.query(
    `UPDATE customers SET billing_status = COALESCE($2, billing_status), plan = COALESCE($3, plan),
            trial_ends_at = COALESCE($4::timestamptz, trial_ends_at) WHERE id = $1`,
    [nordpart.customerId, fields.status ?? null, fields.plan ?? null, fields.trialEndsAt ?? null],
  );
}
const live = (world: ReturnType<typeof makeWorld>, iso: string) => ({ ...world.deps, billingEnabled: true, now: at(iso) });
const exists = async (customerId: string) => (await db.pool.query("SELECT 1 FROM customers WHERE id = $1", [customerId])).rowCount === 1;
const mailsTo = (world: ReturnType<typeof makeWorld>, nordpart: Nordpart) => world.mailer.sent.filter((m) => m.to.includes(nordpart.email));

describe("what an account may do", () => {
  const trial = { plan: "run" as const, billingStatus: "trial" as const, trialEndsAt: new Date(TRIAL_END) };
  const all = { work: true, offers: true, reminders: true };
  const none = { work: false, offers: false, reminders: false };

  it("gives a trial everything until it ends, and nothing after", () => {
    expect(entitlements(trial, new Date("2020-01-14T23:59:00Z"), true)).toEqual(all);
    expect(entitlements(trial, new Date(TRIAL_END), true)).toEqual(none);
    expect(trialDaysLeft(trial.trialEndsAt, new Date("2020-01-13T00:00:00Z"))).toBe(2);
    expect(trialDaysLeft(trial.trialEndsAt, new Date("2020-01-14T12:00:00Z"))).toBe(1);
    expect(trialDaysLeft(trial.trialEndsAt, new Date("2020-02-01T00:00:00Z"))).toBe(0);
  });

  it("separates Start from Run, and leaves our own accounts alone", () => {
    const later = new Date("2021-01-01T00:00:00Z");
    expect(entitlements({ ...trial, billingStatus: "active", plan: "run" }, later, true)).toEqual(all);
    expect(entitlements({ ...trial, billingStatus: "active", plan: "start" }, later, true)).toEqual({ work: true, offers: false, reminders: false });
    expect(entitlements({ ...trial, billingStatus: "read_only" }, later, true)).toEqual(none);
    expect(entitlements({ ...trial, billingStatus: "internal", plan: "start" }, later, true)).toEqual(all);
  });

  it("applies none of it while billing is not switched on", () => {
    expect(entitlements({ ...trial, billingStatus: "read_only" }, new Date("2021-01-01T00:00:00Z"), false)).toEqual(all);
  });
});

describe("Scenario 33: a trial without a card", () => {
  it("reminds on day 12, goes read-only on day 14, warns and deletes after 60 days", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await setBilling(nordpart, { trialEndsAt: TRIAL_END });

    // Day 11: nothing yet.
    expect(await billingTick(live(world, "2020-01-12T12:00:00Z"))).toEqual({ reminders: 0, ended: 0, warnings: 0, deleted: 0 });
    expect(mailsTo(world, nordpart)).toHaveLength(0);

    // Day 12: one reminder, however often the job runs.
    expect(await billingTick(live(world, "2020-01-13T01:00:00Z"))).toMatchObject({ reminders: 1, ended: 0 });
    expect(await billingTick(live(world, "2020-01-13T02:00:00Z"))).toMatchObject({ reminders: 0 });
    const reminder = mailsTo(world, nordpart)[0]!;
    expect(reminder.subject).toBe("Your Adminwise trial ends in 2 days");
    expect(reminder.textBody).toContain("ends on 2020-01-15");
    expect(reminder.textBody).toContain("https://app.test/settings#plan");
    // Still a full account.
    expect((await nordpart.scope.getCustomer()).billingStatus).toBe("trial");

    // Day 14: read-only, and the owner is told once.
    expect(await billingTick(live(world, "2020-01-15T01:00:00Z"))).toMatchObject({ ended: 1 });
    expect(await billingTick(live(world, "2020-01-15T02:00:00Z"))).toMatchObject({ ended: 0 });
    expect(await nordpart.scope.getCustomer()).toMatchObject({ billingStatus: "read_only", readOnlySince: new Date("2020-01-15T01:00:00Z") });
    expect(mailsTo(world, nordpart).at(-1)!.subject).toBe("Your Adminwise trial has ended");

    // Read-only: the mailbox is not read, and no brief, follow-up or reminder is queued.
    world.outlook.mailbox.set("graph-q08", toInbound(quoteFixture("q08")));
    const readOnly = live(world, "2020-01-16T09:00:00Z");
    expect(await syncMailbox(readOnly, { customerId: nordpart.customerId, connectionId: nordpart.microsoftId })).toBe(0);
    expect(await fetchGraphMessage(readOnly, { customerId: nordpart.customerId, connectionId: nordpart.microsoftId, providerMessageId: "graph-q08" })).toBe(false);
    expect((await nordpart.scope.listJobRuns()).filter((r) => r.job === "sync-mailbox")).toHaveLength(0);
    await briefTick(readOnly);
    await chaseTick(readOnly);
    expect(world.queue.jobs.filter((j) => (j.data as { customerId?: string }).customerId === nordpart.customerId)).toHaveLength(0);
    expect(world.outlook.drafts).toHaveLength(0);

    // 52 days read-only: nothing. 53 days: the warning, with the date.
    expect(await billingTick(live(world, "2020-03-07T01:00:00Z"))).toMatchObject({ warnings: 0, deleted: 0 });
    expect(await billingTick(live(world, "2020-03-08T01:00:00Z"))).toMatchObject({ warnings: 1, deleted: 0 });
    const warning = mailsTo(world, nordpart).at(-1)!;
    expect(warning.subject).toBe("Your Adminwise account will be deleted on 2020-03-15");
    expect(warning.textBody).toContain("read-only since 2020-01-15");

    // One hour before the 60 days are over it is still there; after, it is gone with everything in it.
    expect(await billingTick(live(world, "2020-03-15T00:00:00Z"))).toMatchObject({ warnings: 0, deleted: 0 });
    expect(await exists(nordpart.customerId)).toBe(true);
    expect(await billingTick(live(world, "2020-03-15T01:00:00Z"))).toMatchObject({ deleted: 1 });
    expect(await exists(nordpart.customerId)).toBe(false);
    for (const table of ["users", "mailbox_connections", "messages", "job_runs", "audit_events"]) {
      const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE customer_id = $1`, [nordpart.customerId]);
      expect(rows[0].n, table).toBe(0);
    }
    // Reminder, trial ended, warning, and a last mail confirming the deletion.
    expect(mailsTo(world, nordpart)).toHaveLength(4);
    expect(mailsTo(world, nordpart).at(-1)!.subject).toBe("Your Adminwise account has been deleted");
  });

  it("never deletes without a week's warning, and never an account that paid in the meantime", async () => {
    const world = makeWorld(db);
    const late = await createNordpart(db);
    const paid = await createNordpart(db);
    // Both were read-only for 90 days before anyone looked (the job did not run): warned now, deleted a week later at the earliest.
    for (const n of [late, paid]) {
      await db.pool.query("UPDATE customers SET billing_status = 'read_only', read_only_since = $2, trial_ends_at = $2 WHERE id = $1", [n.customerId, "2020-01-01T00:00:00Z"]);
    }
    expect(await billingTick(live(world, "2020-04-01T00:00:00Z"))).toMatchObject({ warnings: 2, deleted: 0 });
    expect(mailsTo(world, late).at(-1)!.subject).toBe("Your Adminwise account will be deleted on 2020-04-08");
    expect(await billingTick(live(world, "2020-04-07T00:00:00Z"))).toMatchObject({ deleted: 0 });

    // One of them chooses a plan.
    await setBilling(paid, { status: "active" });
    expect(await billingTick(live(world, "2020-04-08T00:00:00Z"))).toMatchObject({ deleted: 1 });
    expect(await exists(late.customerId)).toBe(false);
    expect(await exists(paid.customerId)).toBe(true);
    // The guard also holds when the deletion is asked for directly.
    expect(await system(db).deleteCustomer(paid.customerId, true)).toBe(false);
  });

  it("leaves paying accounts and our own accounts alone, and does nothing while billing is off", async () => {
    const world = makeWorld(db);
    const paying = await createNordpart(db);
    const own = await createNordpart(db);
    const trial = await createNordpart(db);
    await setBilling(paying, { status: "active", plan: "start", trialEndsAt: TRIAL_END });
    await setBilling(own, { status: "internal", trialEndsAt: TRIAL_END });
    await setBilling(trial, { trialEndsAt: TRIAL_END });

    // Billing not switched on: the sweep does not run, and an ended trial keeps working.
    expect(await billingTick({ ...world.deps, now: at("2020-06-01T00:00:00Z") })).toBe("off");
    expect((await trial.scope.getCustomer()).billingStatus).toBe("trial");
    await ingestInbound(trial.scope, world.queue, trial.microsoftId, toInbound(quoteFixture("q08")));
    await world.queue.drain({ ...world.deps, now: at("2020-06-01T09:00:00Z") });
    expect(world.outlook.drafts).toHaveLength(1);

    await billingTick(live(world, "2020-06-01T00:00:00Z"));
    expect((await paying.scope.getCustomer()).billingStatus).toBe("active");
    expect((await own.scope.getCustomer()).billingStatus).toBe("internal");
    expect(mailsTo(world, paying)).toHaveLength(0);
    expect(mailsTo(world, own)).toHaveLength(0);
    // The trial account, with billing on, is now read-only: mail already taken in is not handled either.
    expect((await trial.scope.getCustomer()).billingStatus).toBe("read_only");
    const { messageId } = await ingestInbound(trial.scope, world.queue, trial.microsoftId, toInbound(quoteFixture("q10")));
    await world.queue.drain(live(world, "2020-06-01T09:00:00Z"));
    expect(world.outlook.drafts).toHaveLength(1);
    expect((await trial.scope.listJobRuns()).find((r) => r.ref === messageId)).toMatchObject({ status: "skipped", outcome: "read_only" });
  });
});

describe("Start and Run", () => {
  it("on Start a quote request gets an ordinary reply, and invoices are not tracked or reminded", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await giveNordpartPriceList(nordpart.scope);
    await setBilling(nordpart, { status: "active", plan: "start" });
    const deps = live(world, "2026-11-24T13:00:00Z");

    const { messageId } = await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, toInbound(quoteFixture("q01")));
    await world.queue.drain(deps);
    expect(world.outlook.drafts).toHaveLength(1);
    expect(world.outlook.drafts[0]!.attachments).toHaveLength(0);
    expect(world.pdf.pages).toHaveLength(0);
    expect(world.ai.of("quote-request")).toHaveLength(0);
    expect((await nordpart.scope.listJobRuns()).find((r) => r.ref === messageId && r.job === "reply-draft")).toMatchObject({ outcome: "drafted:outlook" });

    expect(await remindCustomer(deps, { customerId: nordpart.customerId, localDate: "2026-11-24" })).toEqual({ status: "not_in_plan", reminders: 0 });
    expect(await trackSentInvoices(deps, { customerId: nordpart.customerId, messageId: messageId! })).toBe("not_in_plan");
    await chaseTick(deps);
    const queued = world.queue.jobs.filter((j) => (j.data as { customerId?: string }).customerId === nordpart.customerId).map((j) => j.queue);
    expect(queued).toContain("chase-customer");
    expect(queued).not.toContain("remind-customer");
  });

  it("on Run the same request gets its offer", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await giveNordpartPriceList(nordpart.scope);
    await setBilling(nordpart, { status: "active", plan: "run" });
    await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, toInbound(quoteFixture("q01")));
    await world.queue.drain(live(world, "2026-11-24T13:00:00Z"));
    expect(world.outlook.drafts[0]!.attachments).toHaveLength(1);
  });
});
