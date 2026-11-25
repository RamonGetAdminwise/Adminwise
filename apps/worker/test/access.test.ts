import type { Db } from "@adminwise/db";
import { system } from "@adminwise/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "./helpers";

/** A new customer gets in by a request that the owner of the service approves. */
describe("requests for access", () => {
  let db: Db;
  beforeAll(() => {
    db = openTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const ask = (email: string, company = "Nordpart Ltd") =>
    system(db).createAccessRequest({ email, company, contactName: "Anna Kowalska", mailSystem: "microsoft365", note: "Quotes take my evenings." });

  it("stores a request as waiting and tells that the owner must hear of it", async () => {
    const made = await ask("anna@nordpart-access.example");
    expect(made).toMatchObject({ status: "pending", fresh: true });
    expect(await system(db).getAccessRequest(made.id)).toMatchObject({
      email: "anna@nordpart-access.example",
      company: "Nordpart Ltd",
      contactName: "Anna Kowalska",
      mailSystem: "microsoft365",
      status: "pending",
      decidedAt: null,
    });
  });

  it("keeps one request per address: asking again while waiting is not news", async () => {
    const first = await ask("twice@nordpart-access.example");
    const again = await ask("twice@nordpart-access.example", "Nordpart Limited");
    expect(again).toMatchObject({ id: first.id, status: "pending", fresh: false });
    // The newer details replace the older ones.
    expect((await system(db).getAccessRequest(first.id))?.company).toBe("Nordpart Limited");
  });

  it("is decided once", async () => {
    const made = await ask("once@nordpart-access.example");
    expect(await system(db).decideAccessRequest(made.id, "approved")).toMatchObject({ status: "approved" });
    // A second press, or the other button afterwards, changes nothing.
    expect(await system(db).decideAccessRequest(made.id, "declined")).toBeNull();
    expect((await system(db).findAccessRequest("once@nordpart-access.example"))?.status).toBe("approved");
  });

  it("stays approved when the same address asks again", async () => {
    const made = await ask("stays@nordpart-access.example");
    await system(db).decideAccessRequest(made.id, "approved");
    const again = await ask("stays@nordpart-access.example", "Another name");
    expect(again).toMatchObject({ status: "approved", fresh: false });
    expect((await system(db).getAccessRequest(made.id))?.company).toBe("Nordpart Ltd");
  });

  it("can be asked again after a decline, and then the owner hears of it again", async () => {
    const made = await ask("later@nordpart-access.example");
    await system(db).decideAccessRequest(made.id, "declined");
    const again = await ask("later@nordpart-access.example");
    expect(again).toMatchObject({ id: made.id, status: "pending", fresh: true });
    expect((await system(db).getAccessRequest(made.id))?.decidedAt).toBeNull();
  });

  it("is cleared away: a decline after 30 days, an undecided request after 90, and with a closed account", async () => {
    const sys = system(db);
    const declined = await ask("old-no@nordpart-access.example");
    await sys.decideAccessRequest(declined.id, "declined");
    const waiting = await ask("old-wait@nordpart-access.example");
    const approved = await ask("old-yes@nordpart-access.example");
    await sys.decideAccessRequest(approved.id, "approved");

    // The rows are made older rather than the clock moved on: other tests share this database.
    const age = (id: string, days: number) =>
      db.pool.query(
        `UPDATE access_requests SET created_at = now() - make_interval(days => $2),
           decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE now() - make_interval(days => $2) END WHERE id = $1`,
        [id, days],
      );
    await age(declined.id, 29);
    await age(waiting.id, 89);
    await age(approved.id, 400);
    await sys.prune(new Date(), 30);
    expect(await sys.getAccessRequest(declined.id)).not.toBeNull();
    expect(await sys.getAccessRequest(waiting.id)).not.toBeNull();
    await age(declined.id, 31);
    await age(waiting.id, 91);
    await sys.prune(new Date(), 30);
    expect(await sys.getAccessRequest(declined.id)).toBeNull();
    expect(await sys.getAccessRequest(waiting.id)).toBeNull();
    // An approved request stays: it is what lets that address in.
    expect(await sys.getAccessRequest(approved.id)).not.toBeNull();

    const account = await sys.createCustomerWithUser({ email: "old-yes@nordpart-access.example", slug: "nordpart-access-closing" });
    expect(await sys.deleteCustomer(account.customerId)).toBe(true);
    expect(await sys.getAccessRequest(approved.id)).toBeNull();
  });

  it("counts requests for the daily brake", async () => {
    const before = await system(db).countAccessRequests(new Date(Date.now() - 3_600_000));
    await ask("count@nordpart-access.example");
    expect(await system(db).countAccessRequests(new Date(Date.now() - 3_600_000))).toBe(before + 1);
  });
});
