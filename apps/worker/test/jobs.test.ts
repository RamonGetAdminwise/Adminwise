import { ingestInbound, QUEUES } from "@adminwise/core";
import { forCustomer, system, type Db } from "@adminwise/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefTick, composeBrief, sendBrief } from "../src/jobs/brief";
import { purgeBodies } from "../src/jobs/purge";
import { fetchGraphMessage, pollTick, syncMailbox } from "../src/jobs/sync";
import { createNordpart, fixture, makeWorld, openTestDb, toInbound } from "./helpers";

let db: Db;
beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("24-hour body purge", () => {
  it("empties bodies, sender addresses and draft text after 23 hours and keeps the metadata", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const { messageId } = await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, toInbound(fixture("n01")));
    await world.queue.drain(world.deps);

    // 22 hours later: still there.
    await purgeBodies({ ...world.deps, now: () => new Date(Date.now() + 22 * 3_600_000) });
    expect((await nordpart.scope.getMessage(messageId!))!.bodyText).toContain("PZ-40");

    // 23 hours and a minute later: gone.
    await purgeBodies({ ...world.deps, now: () => new Date(Date.now() + 23 * 3_600_000 + 60_000) });
    const message = (await nordpart.scope.getMessage(messageId!))!;
    expect(message.bodyText).toBeNull();
    expect(message.fromAddress).toBeNull();
    expect(message.bodyPurgedAt).toBeInstanceOf(Date);
    // Metadata survives.
    expect(message).toMatchObject({ subject: "Dostępność pompy hydraulicznej PZ-40", senderDomain: "rolmet.example", classification: "business" });
    const draft = (await nordpart.scope.listDraftsForMessage(messageId!))[0]!;
    expect(draft.bodyText).toBeNull();
    expect(draft.status).toBe("created");
  });
});

describe("Daily brief (phase-1 version)", () => {
  const base = { appName: "Adminwise", appBaseUrl: "https://app.test", localDate: "2026-11-10" };

  it("is one line when nothing happened", () => {
    const brief = composeBrief({ ...base, drafts: [], problems: [] });
    expect(brief.textBody.trim()).toBe("Nothing needed your attention yesterday. Adminwise is running.");
  });

  it("leaves out empty sections", () => {
    const draftsOnly = composeBrief({
      ...base,
      drafts: [{ id: "1", subject: "Quote request", senderDomain: "halvorsen-maskin.example", language: "en", languageListed: true, destination: "outlook_drafts" }],
      problems: [],
    });
    expect(draftsOnly.textBody).toContain("DRAFTS PREPARED YESTERDAY (1)");
    expect(draftsOnly.textBody).toContain('"Quote request" (from halvorsen-maskin.example) - in your Outlook Drafts');
    expect(draftsOnly.textBody).not.toContain("CONNECTION PROBLEMS");

    const problemsOnly = composeBrief({
      ...base,
      drafts: [],
      problems: [{ provider: "microsoft", emailAddress: "biuro@nordpart.example", status: "needs_reconnect" }],
    });
    expect(problemsOnly.textBody).not.toContain("DRAFTS PREPARED");
    expect(problemsOnly.textBody).toContain("Reconnect it here: https://app.test/settings");
  });

  it("goes out at 07:30 in the customer's own time zone, once per day", async () => {
    const world = makeWorld(db);
    // Two customers who have not had a brief yet; one in Warsaw, one in New York.
    const warsaw = await createNordpart(db, { timeZone: "Europe/Warsaw", briefStartDate: "2026-11-09" });
    const newYork = await createNordpart(db, { timeZone: "America/New_York", briefStartDate: "2026-11-09" });
    const queuedFor = (id: string) => world.queue.of(QUEUES.sendBrief).filter((j) => j.customerId === id);

    // 07:29 in Warsaw (06:29 UTC in winter): nobody yet.
    await briefTick({ ...world.deps, now: () => new Date("2026-11-10T06:29:00Z") });
    expect(queuedFor(warsaw.customerId)).toHaveLength(0);

    // 07:30 in Warsaw is 01:30 in New York: only Warsaw.
    await briefTick({ ...world.deps, now: () => new Date("2026-11-10T06:30:00Z") });
    expect(queuedFor(warsaw.customerId)).toEqual([{ customerId: warsaw.customerId, localDate: "2026-11-10" }]);
    expect(queuedFor(newYork.customerId)).toHaveLength(0);

    // Send Warsaw's brief; a second attempt for the same date does nothing.
    expect(await sendBrief(world.deps, queuedFor(warsaw.customerId)[0]!)).toBe("sent");
    expect(await sendBrief(world.deps, queuedFor(warsaw.customerId)[0]!)).toBe("already_sent");
    expect(world.mailer.sent).toHaveLength(1);
    expect(world.mailer.sent[0]!.to).toEqual([warsaw.email]);

    // Later ticks that morning do not queue Warsaw again.
    world.queue.jobs = [];
    await briefTick({ ...world.deps, now: () => new Date("2026-11-10T09:00:00Z") });
    expect(queuedFor(warsaw.customerId)).toHaveLength(0);

    // 07:30 in New York (12:30 UTC): now New York.
    await briefTick({ ...world.deps, now: () => new Date("2026-11-10T12:30:00Z") });
    expect(queuedFor(newYork.customerId)).toEqual([{ customerId: newYork.customerId, localDate: "2026-11-10" }]);
  });

  it("lists yesterday's drafts and a disconnected mailbox", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db, { briefStartDate: "2020-01-01" });
    await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, toInbound(fixture("n08")));
    await world.queue.drain(world.deps);
    await nordpart.scope.setConnectionStatus(nordpart.microsoftId, "needs_reconnect", "invalid_grant");

    // "Tomorrow" in Warsaw, so that the draft just made counts as yesterday's.
    const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
    await sendBrief(world.deps, { customerId: nordpart.customerId, localDate: tomorrow });

    const brief = world.mailer.sent.at(-1)!;
    expect(brief.textBody).toContain("DRAFTS PREPARED YESTERDAY (1)");
    expect(brief.textBody).toContain("Datasheet and lead time for gear motor GM-75");
    expect(brief.textBody).toContain("CONNECTION PROBLEMS");
    expect(brief.textBody).toContain("biuro@nordpart.example");
  });

  it("tries again later if sending failed", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db, { briefStartDate: "2026-11-09" });
    world.mailer.send = async () => {
      throw new Error("mail provider down");
    };
    await expect(sendBrief(world.deps, { customerId: nordpart.customerId, localDate: "2026-11-10" })).rejects.toThrow();
    const clocks = await system(db).listCustomerClocks();
    expect(clocks.find((c) => c.id === nordpart.customerId)!.briefLastSentOn).toBe("2026-11-09");
  });
});

describe("Mailbox sync", () => {
  it("polls every connected Microsoft mailbox and takes in what the notification missed", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await pollTick(world.deps);
    expect(world.queue.of(QUEUES.syncMailbox)).toContainEqual({ customerId: nordpart.customerId, connectionId: nordpart.microsoftId });

    const mail = toInbound(fixture("n13"));
    world.outlook.mailbox.set(mail.providerMessageId, mail);
    world.outlook.pending = [mail.providerMessageId];

    // The notification and the poll both deliver it: stored once.
    expect(await fetchGraphMessage(world.deps, { customerId: nordpart.customerId, connectionId: nordpart.microsoftId, providerMessageId: mail.providerMessageId })).toBe(true);
    expect(await syncMailbox(world.deps, { customerId: nordpart.customerId, connectionId: nordpart.microsoftId })).toBe(0);
    expect(world.queue.of(QUEUES.processMessage)).toHaveLength(1);
    expect((await nordpart.scope.getConnection(nordpart.microsoftId))!.lastSyncAt).toBeInstanceOf(Date);
  });
});

describe("Customer scoping", () => {
  it("one customer cannot read another customer's messages, drafts or connections", async () => {
    const world = makeWorld(db);
    const a = await createNordpart(db);
    const b = await createNordpart(db);
    const { messageId } = await ingestInbound(a.scope, world.queue, a.microsoftId, toInbound(fixture("n05")));
    await world.queue.drain(world.deps);

    const asB = forCustomer(db, b.customerId);
    expect(await asB.getMessage(messageId!)).toBeNull();
    expect(await asB.listDraftsForMessage(messageId!)).toHaveLength(0);
    expect(await asB.getConnection(a.microsoftId)).toBeNull();
    expect(await asB.countDrafts()).toBe(0);
    expect(await a.scope.countDrafts()).toBe(1);
  });

  it("stores mailbox tokens encrypted", async () => {
    const nordpart = await createNordpart(db);
    const raw = await db.pool.query("SELECT access_token_enc, refresh_token_enc FROM mailbox_connections WHERE id = $1", [nordpart.microsoftId]);
    expect(raw.rows[0].access_token_enc).toMatch(/^v1:/);
    expect(raw.rows[0].access_token_enc).not.toContain("test-access-token");
    expect(raw.rows[0].refresh_token_enc).not.toContain("test-refresh-token");
    expect((await nordpart.scope.getConnection(nordpart.microsoftId))!.refreshToken).toBe("test-refresh-token");
  });
});
