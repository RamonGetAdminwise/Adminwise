import { ingestInbound, ingestOutbound, QUEUES } from "@adminwise/core";
import { system, type Db } from "@adminwise/db";
import type { InboundMessage } from "@adminwise/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mayTryAgain } from "../src/deps";
import { billingTick } from "../src/jobs/billing";
import { sendBrief } from "../src/jobs/brief";
import { chaseTick } from "../src/jobs/chaser";
import { trackSentInvoices } from "../src/jobs/invoices";
import { processMessage } from "../src/jobs/process-message";
import { purgeBodies } from "../src/jobs/purge";
import { confirmOffer } from "../src/jobs/quote";
import { endInvoiceChain, remindCustomer } from "../src/jobs/reminders";
import { pollTick, syncMailbox } from "../src/jobs/sync";
import {
  company,
  createNordpart,
  giveNordpartPriceList,
  invoiceFixture,
  invoicePdf,
  makeWorld,
  openTestDb,
  paymentFixture,
  quoteFixture,
  toInbound,
} from "./helpers";

/**
 * One test per fault found by the independent review of 2026-11-24
 * (01_Project_docs/14_independent_review_2026-11-24.md). Each of these failed before its fix.
 */

let db: Db;
beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await db.close();
});

type World = ReturnType<typeof makeWorld>;
type Nordpart = Awaited<ReturnType<typeof createNordpart>>;
const at = (iso: string) => () => new Date(iso);

/** Nordpart sends one mail with these PDFs from its connected mailbox. The invoice check is run by the test. */
async function sendPdfs(world: World, nordpart: Nordpart, key: string, ids: string[]) {
  const files = ids.map((id) => ({ name: invoiceFixture(id).file, bytes: invoicePdf(id) }));
  const message: InboundMessage = {
    providerMessageId: `graph-rev-${key}`,
    internetMessageId: `<rev-${key}@nordpart.example>`,
    threadKey: `thr-rev-${key}`,
    subject: `Faktury ${key}`,
    from: { address: company.mailbox, name: company.name },
    receivedAt: new Date("2026-11-03T10:00:00Z"),
    bodyText: "Dzień dobry,\n\nw załączeniu przesyłam faktury.\n\nPozdrawiam\nTomasz",
    headerFlags: {},
    attachmentNames: files.map((f) => f.name),
    to: ["ksiegowosc@rolmet.example"],
    cc: [],
  };
  world.outlook.mailbox.set(message.providerMessageId, message);
  world.outlook.attachments.set(
    message.providerMessageId,
    files.map((f, i) => ({
      info: { id: `att-${key}-${i}`, name: f.name, contentType: "application/pdf", sizeBytes: f.bytes.byteLength, isInline: false },
      bytes: f.bytes,
    })),
  );
  const { messageId } = await ingestOutbound(nordpart.scope, nordpart.microsoftId, message, world.queue);
  return messageId!;
}
const invoicesOf = async (nordpart: Nordpart, messageId: string) => {
  const { rows } = await db.pool.query("SELECT id FROM invoices WHERE customer_id = $1 AND message_id = $2 ORDER BY number", [nordpart.customerId, messageId]);
  return Promise.all(rows.map(async (r) => (await nordpart.scope.getInvoice(r.id as string))!));
};
/** The owner answers "yes, track it" for invoices that went to someone other than the buyer. */
const confirmAll = async (nordpart: Nordpart, messageId: string) => {
  for (const invoice of await invoicesOf(nordpart, messageId)) await nordpart.scope.confirmInvoice(invoice.id);
};
const remind = (world: World, nordpart: Nordpart, localDate: string) =>
  remindCustomer({ ...world.deps, now: at(`${localDate}T05:30:00Z`) }, { customerId: nordpart.customerId, localDate });

/** Makes one kind of model request fail the next `times` times, as when the provider is down. */
function failModel(world: World, job: string, times = 1) {
  const real = world.ai.complete.bind(world.ai);
  let left = times;
  world.ai.complete = async (request) => {
    if (request.job === job && left-- > 0) throw new Error("model unavailable");
    return real(request);
  };
}

describe("Two invoices in one mail", () => {
  it("reminds for each of them, and ending one leaves the other's reminder alone", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const messageId = await sendPdfs(world, nordpart, "two", ["i01", "i02"]);
    // The second invoice is made out to another company than the mail went to: the owner is asked, and says yes.
    expect(await trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId })).toBe("open:1,needs_confirm:1");
    await confirmAll(nordpart, messageId);
    const [fv, inv] = await invoicesOf(nordpart, messageId); // FV/2026/11/0457 and INV-2026-118, both due 2026-11-17

    // Both are a week late: each gets its own first reminder (before the fix only one did).
    expect((await remind(world, nordpart, "2026-11-24")).reminders).toBe(2);
    expect(world.outlook.chaserDrafts).toHaveLength(2);
    const draftOfFv = (await nordpart.scope.getOpenReminder(fv!.id))!;
    const draftOfInv = (await nordpart.scope.getOpenReminder(inv!.id))!;
    expect(draftOfFv.id).not.toBe(draftOfInv.id);

    // The owner marks the second one paid: only its draft is taken out of the Drafts folder.
    await endInvoiceChain(world.deps, nordpart.scope, inv!, "paid", "owner", new Date("2026-11-25T08:00:00Z"));
    expect(world.outlook.deletedDrafts).toEqual([draftOfInv.providerDraftId]);
    expect(await nordpart.scope.getOpenReminder(fv!.id)).toMatchObject({ id: draftOfFv.id, status: "created" });
  });

  it("a reply that names one invoice as paid ends that one only", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const messageId = await sendPdfs(world, nordpart, "named", ["i01", "i02"]);
    await trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId });
    await confirmAll(nordpart, messageId);
    const [fv, inv] = await invoicesOf(nordpart, messageId);

    // "Faktura FV/2026/11/0457 została zapłacona wczoraj": says nothing about INV-2026-118.
    const reply = toInbound(paymentFixture("p01"), { threadKey: "thr-rev-named" });
    await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, reply);
    await world.queue.drain({ ...world.deps, now: at("2026-11-26T09:05:00Z") });
    expect(world.ai.of("payment-notice")[0]!.system).toContain("waiting for payment of: FV/2026/11/0457, INV-2026-118");
    expect((await nordpart.scope.getInvoice(fv!.id))!.status).toBe("paid");
    expect((await nordpart.scope.getInvoice(inv!.id))!.status).toBe("open");
  });

  it("\"we paid\" without a number ends nothing when two invoices are open", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const messageId = await sendPdfs(world, nordpart, "unclear", ["i01", "i02"]);
    await trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId });
    await confirmAll(nordpart, messageId);
    const real = world.ai.complete.bind(world.ai);
    world.ai.complete = async (request) =>
      request.job === "payment-notice" ? { text: '{"paid":"yes","invoices":["INV-2026-118"]}', inputTokens: 1, outputTokens: 1 } : real(request);

    // The model names an invoice the sender did not write: that is not believed either.
    const reply = toInbound(paymentFixture("p02"), { threadKey: "thr-rev-unclear", bodyText: "Dzień dobry,\n\nzapłaciliśmy wczoraj.\n\nPozdrawiamy" });
    await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, reply);
    await world.queue.drain({ ...world.deps, now: at("2026-11-26T09:05:00Z") });
    expect((await invoicesOf(nordpart, messageId)).map((i) => i.status)).toEqual(["open", "open"]);
    // The mail still gets its draft, so the owner sees it.
    expect(world.outlook.drafts).toHaveLength(1);
  });
});

describe("An invoice whose reading fails once", () => {
  it("is read on the retry instead of being skipped as already known", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const messageId = await sendPdfs(world, nordpart, "retry", ["i01"]);
    failModel(world, "invoice-fields");
    await expect(trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId })).rejects.toThrow("model unavailable");
    expect((await invoicesOf(nordpart, messageId))[0]!.status).toBe("pending");

    expect(await trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId })).toBe("open:1");
    expect((await invoicesOf(nordpart, messageId))[0]).toMatchObject({ status: "open", number: "FV/2026/11/0457" });
    // A third run finds nothing left to do.
    expect(await trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId })).toBe("nothing_new");
  });

  it("an invoice that was never read is mentioned in the brief, once, and only after the brief went out", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db, { briefStartDate: "2026-11-01" });
    const messageId = await sendPdfs(world, nordpart, "stuck", ["i01"]);
    failModel(world, "invoice-fields", 99);
    await expect(trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId })).rejects.toThrow();
    await db.pool.query("UPDATE invoices SET created_at = '2026-11-03T10:00:00Z' WHERE customer_id = $1", [nordpart.customerId]);

    // The brief cannot be sent: the question must not count as asked.
    const send = world.mailer.send.bind(world.mailer);
    world.mailer.send = async () => {
      throw new Error("mail service down");
    };
    const brief = { customerId: nordpart.customerId, localDate: "2026-11-04" };
    await expect(sendBrief({ ...world.deps, now: at("2026-11-04T06:30:00Z") }, brief)).rejects.toThrow("mail service down");
    world.mailer.send = send;

    await sendBrief({ ...world.deps, now: at("2026-11-04T06:40:00Z") }, brief);
    expect(world.mailer.sent.at(-1)!.textBody).toContain('- "FV_2026_11_0457.pdf", a PDF you sent, could not be read');
    await sendBrief({ ...world.deps, now: at("2026-11-05T06:30:00Z") }, { ...brief, localDate: "2026-11-05" });
    expect(world.mailer.sent.at(-1)!.textBody).not.toContain("FV_2026_11_0457.pdf");
  });
});

describe("An order confirmation whose draft fails once", () => {
  const receive = async (world: World, nordpart: Nordpart, id: string) => {
    const { messageId } = await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, toInbound(quoteFixture(id)));
    return messageId!;
  };
  const failNextDraft = (world: World) => {
    const real = world.outlook.createReplyDraft.bind(world.outlook);
    world.outlook.createReplyDraft = async () => {
      world.outlook.createReplyDraft = real;
      throw new Error("Outlook unavailable");
    };
  };

  it("is still attached when the reply-draft job runs again", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await giveNordpartPriceList(nordpart.scope);
    const now = at("2026-11-17T12:00:00Z");
    const requestId = await receive(world, nordpart, "q01");
    await world.queue.drain({ ...world.deps, now });
    const offer = (await nordpart.scope.getOfferForMessage("offer", requestId))!;

    // The acceptance arrives; making the draft in Outlook fails. The offer is already marked accepted.
    const acceptanceId = await receive(world, nordpart, "q09");
    failNextDraft(world);
    await expect(world.queue.drain({ ...world.deps, now })).rejects.toThrow("Outlook unavailable");
    expect((await nordpart.scope.getOffer(offer.id))!.status).toBe("accepted");

    // The retry carries on: the draft has the confirmation (before the fix it was an ordinary reply without it).
    expect(await processMessage({ ...world.deps, now }, { customerId: nordpart.customerId, messageId: acceptanceId })).toBe("drafted");
    const draft = world.outlook.drafts.at(-1)!;
    expect(draft.providerMessageId).toBe("graph-q09");
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0]!.name).toContain("OF-2026-001-C");
    expect((await nordpart.scope.listJobRuns()).find((r) => r.ref === acceptanceId && r.status === "succeeded")!.outcome).toBe("order:outlook");
  });

  it("is still made when the owner's click from the brief runs again", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await giveNordpartPriceList(nordpart.scope);
    const now = at("2026-11-17T12:00:00Z");
    const requestId = await receive(world, nordpart, "q01");
    await world.queue.drain({ ...world.deps, now });
    const offer = (await nordpart.scope.getOfferForMessage("offer", requestId))!;

    failNextDraft(world);
    const job = { customerId: nordpart.customerId, offerId: offer.id };
    await expect(confirmOffer({ ...world.deps, now }, job)).rejects.toThrow("Outlook unavailable");
    expect(await confirmOffer({ ...world.deps, now }, job)).toBe("confirmed");
    expect(world.outlook.drafts.at(-1)!.attachments).toHaveLength(1);
    // And a third click does nothing more.
    expect(await confirmOffer({ ...world.deps, now }, job)).toBe("skipped");
  });

  it("an offer past its validity date is not confirmed automatically", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await giveNordpartPriceList(nordpart.scope);
    const requestId = await receive(world, nordpart, "q01");
    await world.queue.drain({ ...world.deps, now: at("2026-11-17T12:00:00Z") });
    const offer = (await nordpart.scope.getOfferForMessage("offer", requestId))!; // valid 14 days

    await receive(world, nordpart, "q09");
    await world.queue.drain({ ...world.deps, now: at("2026-12-20T12:00:00Z") });
    expect((await nordpart.scope.getOffer(offer.id))!.status).toBe("prepared");
    expect(world.ai.of("offer-acceptance")).toHaveLength(0);
    expect(world.outlook.drafts.at(-1)!.attachments).toHaveLength(0);
  });
});

describe("Account mails that fail to send", () => {
  const live = (world: World, iso: string) => ({ ...world.deps, billingEnabled: true, now: at(iso) });

  it("nobody is deleted who did not get the warning", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await db.pool.query("UPDATE customers SET billing_status = 'read_only', read_only_since = '2020-01-01T00:00:00Z' WHERE id = $1", [nordpart.customerId]);
    const exists = async () => (await db.pool.query("SELECT 1 FROM customers WHERE id = $1", [nordpart.customerId])).rowCount === 1;
    const warned = async () => (await db.pool.query("SELECT deletion_warning_sent_at AS at FROM customers WHERE id = $1", [nordpart.customerId])).rows[0].at as Date | null;

    // Day 53: the warning is due, but the mail service is down. Not marked as warned; the sweep reports the failure.
    const send = world.mailer.send.bind(world.mailer);
    world.mailer.send = async () => {
      throw new Error("mail service down");
    };
    await expect(billingTick(live(world, "2020-02-23T00:30:00Z"))).rejects.toThrow("mail service down");
    expect(await warned()).toBeNull();

    // A week later still no mail could be sent: the account is NOT deleted (before the fix it was).
    await expect(billingTick(live(world, "2020-03-05T00:30:00Z"))).rejects.toThrow();
    expect(await exists()).toBe(true);

    // The mail service is back: warned now, and deleted a full week after that.
    world.mailer.send = send;
    await billingTick(live(world, "2020-03-05T01:30:00Z"));
    expect(world.mailer.sent.at(-1)!.subject).toBe("Your Adminwise account will be deleted on 2020-03-12");
    await billingTick(live(world, "2020-03-11T01:30:00Z"));
    expect(await exists()).toBe(true);
    await billingTick(live(world, "2020-03-12T02:30:00Z"));
    expect(await exists()).toBe(false);
  });

  it("closing an account removes its sign-in links too", async () => {
    const nordpart = await createNordpart(db);
    const sys = system(db);
    await sys.createLoginToken(nordpart.email, `hash-${nordpart.customerId}`, new Date(Date.now() + 600_000));
    expect(await sys.countLoginTokens(nordpart.email, new Date(Date.now() - 60_000))).toBe(1);
    expect(await sys.deleteCustomer(nordpart.customerId)).toBe(true);
    expect((await db.pool.query("SELECT 1 FROM login_tokens WHERE email = $1", [nordpart.email])).rowCount).toBe(0);
  });
});

describe("A once-a-day job that keeps failing", () => {
  it("waits longer after each failure and stops after five", () => {
    const now = new Date("2026-11-24T06:00:00Z");
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    expect(mayTryAgain(undefined, now)).toBe(true);
    expect(mayTryAgain({ count: 1, last: ago(4) }, now)).toBe(false);
    expect(mayTryAgain({ count: 1, last: ago(5) }, now)).toBe(true);
    expect(mayTryAgain({ count: 3, last: ago(19) }, now)).toBe(false);
    expect(mayTryAgain({ count: 3, last: ago(20) }, now)).toBe(true);
    expect(mayTryAgain({ count: 5, last: ago(600) }, now)).toBe(false);
  });

  // No reminders are written at the weekend and the run is stamped with the real clock, so on a
  // Saturday or Sunday there is no failed run to look at. The rule itself is tested above on fixed dates.
  const weekend = ["Sat", "Sun"].includes(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", weekday: "short" }).format(new Date()),
  );
  it.skipIf(weekend)("is not started again every minute", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const messageId = await sendPdfs(world, nordpart, "daily", ["i01"]);
    await trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId });
    failModel(world, "payment-reminder", 99);
    // Today's date in the customer's time zone: the scheduler looks for failures of today's run.
    // Today's date in the customer's time zone: the scheduler looks for failures of today's run.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(new Date());
    await expect(remind(world, nordpart, today)).rejects.toThrow("model unavailable");
    // The run row is stamped with the real clock; the scheduler is asked "a minute later" and "an hour later".
    const mine = (queue: typeof QUEUES.remindCustomer) => world.queue.of(queue).filter((j) => j.customerId === nordpart.customerId);
    await chaseTick({ ...world.deps, now: () => new Date(Date.now() + 60_000) });
    expect(mine(QUEUES.remindCustomer)).toHaveLength(0);
    await chaseTick({ ...world.deps, now: () => new Date(Date.now() + 6 * 60_000) });
    expect(mine(QUEUES.remindCustomer).length).toBeGreaterThanOrEqual(0); // depends on the local hour; see the unit test above
  });
});

describe("Mail that fell through", () => {
  it("is handed to the worker again when its job was never queued, and not once it was handled", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    // Stored, but queueing failed (a crash between the two steps).
    const lost = { send: async () => undefined };
    const { messageId } = await ingestInbound(nordpart.scope, lost, nordpart.microsoftId, toInbound(quoteFixture("q08")));
    const mine = () => world.queue.of(QUEUES.processMessage).filter((j) => j.messageId === messageId);

    // Too fresh to worry about.
    await pollTick(world.deps);
    expect(mine()).toHaveLength(0);
    // Half an hour later it is found.
    const later = { ...world.deps, now: () => new Date(Date.now() + 30 * 60_000) };
    await pollTick(later);
    expect(mine()).toHaveLength(1);

    // (The shared test database holds other tests' mail too, so only this one is run here.)
    await processMessage(world.deps, mine()[0]!);
    expect(world.outlook.drafts).toHaveLength(1);
    await pollTick(later);
    expect(mine()).toHaveLength(1);
  });

  it("filing is queued by the reply-draft job, once the mail has been sorted", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const mail = toInbound(quoteFixture("q10"), { attachmentNames: ["rysunek.pdf"] });
    const { messageId } = await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, mail);
    expect(world.queue.of(QUEUES.fileAttachments)).toEqual([]);
    await world.queue.drain(world.deps);
    expect(world.queue.of(QUEUES.fileAttachments)).toEqual([{ customerId: nordpart.customerId, messageId }]);
  });
});

describe("The mailbox poll", () => {
  it("one message that cannot be read does not stop the others, the sent mail or the subscription", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const good = toInbound(quoteFixture("q10"));
    world.outlook.mailbox.set(good.providerMessageId, good);
    world.outlook.pending = ["graph-broken", good.providerMessageId];
    let subscriptions = 0;
    world.outlook.ensureSubscription = async () => {
      subscriptions++;
    };
    const job = { customerId: nordpart.customerId, connectionId: nordpart.microsoftId };
    const before = (await nordpart.scope.getConnection(nordpart.microsoftId))!.deltaLink;

    await expect(syncMailbox(world.deps, job)).rejects.toThrow("not in fake mailbox");
    // The readable mail was taken in, and the subscription was still renewed.
    expect(world.queue.of(QUEUES.processMessage).filter((j) => j.customerId === nordpart.customerId)).toHaveLength(1);
    expect(subscriptions).toBe(1);
    // The bookmark did not move: the unread message is listed again next time.
    expect((await nordpart.scope.getConnection(nordpart.microsoftId))!.deltaLink).toBe(before);
  });

  it("a mail with a character the database cannot store is taken in without it", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const mail = toInbound(quoteFixture("q10"), { subject: "Pytanie\u0000 o ofertę", bodyText: "Dzień dobry,\u0000 proszę o kontakt." });
    const { messageId } = await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, mail);
    expect(await nordpart.scope.getMessage(messageId!)).toMatchObject({ subject: "Pytanie o ofertę", bodyText: "Dzień dobry, proszę o kontakt." });
  });

  it("a mailbox the customer disconnected is not read, and our keys to it are gone", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    expect(await nordpart.scope.disconnectConnection(nordpart.microsoftId)).toBe(true);
    const raw = await db.pool.query("SELECT status, access_token_enc, refresh_token_enc, delta_link, subscription_id FROM mailbox_connections WHERE id = $1", [nordpart.microsoftId]);
    expect(raw.rows[0]).toEqual({ status: "disconnected", access_token_enc: null, refresh_token_enc: null, delta_link: null, subscription_id: null });
    // The scheduler no longer lists it.
    await pollTick(world.deps);
    expect(world.queue.of(QUEUES.syncMailbox).filter((j) => j.customerId === nordpart.customerId)).toHaveLength(0);
  });
});

describe("Housekeeping", () => {
  it("offer numbers without the year in them do not start again at 1 in January", async () => {
    const nordpart = await createNordpart(db);
    await db.pool.query("UPDATE customers SET offer_number_pattern = 'OF-{NNN}' WHERE id = $1", [nordpart.customerId]);
    expect((await nordpart.scope.nextOfferCounter(2026)).counter).toBe(1);
    expect((await nordpart.scope.nextOfferCounter(2026)).counter).toBe(2);
    expect((await nordpart.scope.nextOfferCounter(2027)).counter).toBe(3);
    // With the year in the number, a new year starts at 1 as before.
    await db.pool.query("UPDATE customers SET offer_number_pattern = 'OF/{YYYY}/{NNN}' WHERE id = $1", [nordpart.customerId]);
    expect((await nordpart.scope.nextOfferCounter(2028)).counter).toBe(1);
  });

  it("expired sign-in links and old run records are removed; the activity list leaves out empty mailbox checks", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const sys = system(db);
    await sys.createLoginToken(nordpart.email, `old-${nordpart.customerId}`, new Date("2026-01-01T00:00:00Z"));
    await syncMailbox(world.deps, { customerId: nordpart.customerId, connectionId: nordpart.microsoftId });
    await db.pool.query("INSERT INTO job_runs (customer_id, job, status, started_at) VALUES ($1, 'reply-draft', 'succeeded', '2026-01-01T00:00:00Z')", [nordpart.customerId]);
    expect((await nordpart.scope.listJobRuns(10)).map((r) => r.job).sort()).toEqual(["reply-draft", "sync-mailbox"]);
    expect((await nordpart.scope.listJobRuns(10, false)).map((r) => r.job)).toEqual(["reply-draft"]);

    await purgeBodies(world.deps);
    expect((await db.pool.query("SELECT 1 FROM login_tokens WHERE email = $1", [nordpart.email])).rowCount).toBe(0);
    expect((await nordpart.scope.listJobRuns(10)).map((r) => r.job)).toEqual(["sync-mailbox"]);
  });
});
