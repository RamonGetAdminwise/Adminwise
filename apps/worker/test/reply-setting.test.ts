import { ingestInbound, ingestOutbound } from "@adminwise/core";
import type { Db, ReplyDraftMode } from "@adminwise/db";
import type { InboundMessage } from "@adminwise/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trackSentInvoices } from "../src/jobs/invoices";
import { remindCustomer } from "../src/jobs/reminders";
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

/** The owner picks a choice on the settings page; everything else stays as it was. */
async function choose(nordpart: Nordpart, replyDrafts: ReplyDraftMode) {
  const c = await nordpart.scope.getCustomer();
  await nordpart.scope.updateSettings({ name: c.name, languages: c.languages, timeZone: c.timeZone, signatureText: c.signatureText, replyDrafts });
  expect((await nordpart.scope.getCustomer()).replyDrafts).toBe(replyDrafts);
}

async function receive(world: World, nordpart: Nordpart, message: InboundMessage, when = "2026-11-24T13:00:00Z") {
  const { messageId } = await ingestInbound(nordpart.scope, world.queue, nordpart.microsoftId, message);
  await world.queue.drain({ ...world.deps, now: at(when) });
  return messageId!;
}

async function outcomeOf(nordpart: Nordpart, messageId: string) {
  const { rows } = await db.pool.query(
    "SELECT outcome FROM job_runs WHERE customer_id = $1 AND job = 'reply-draft' AND ref = $2",
    [nordpart.customerId, messageId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].outcome as string;
}
async function draftRows(nordpart: Nordpart, messageId: string) {
  const { rows } = await db.pool.query("SELECT id FROM drafts WHERE customer_id = $1 AND message_id = $2", [nordpart.customerId, messageId]);
  return rows.length;
}

/** Nordpart sends invoice i01 (due 2026-11-17) and the first reminder is prepared. */
async function chaseInvoice(world: World, nordpart: Nordpart) {
  const message: InboundMessage = {
    providerMessageId: "graph-inv-i01",
    internetMessageId: "<inv-i01@nordpart.example>",
    threadKey: "thr-inv-i01",
    subject: "Faktura i01",
    from: { address: company.mailbox, name: company.name },
    receivedAt: new Date("2026-11-03T10:00:00Z"),
    bodyText: "Dzień dobry,\n\nw załączeniu przesyłam fakturę.\n\nPozdrawiam\nTomasz",
    headerFlags: {},
    attachmentNames: [invoiceFixture("i01").file],
    to: ["ksiegowosc@rolmet.example"],
    cc: [],
  };
  const bytes = invoicePdf("i01");
  world.outlook.mailbox.set(message.providerMessageId, message);
  world.outlook.attachments.set(message.providerMessageId, [
    { info: { id: "att-i01", name: invoiceFixture("i01").file, contentType: "application/pdf", sizeBytes: bytes.byteLength, isInline: false }, bytes },
  ]);
  const { messageId } = await ingestOutbound(nordpart.scope, nordpart.microsoftId, message, world.queue);
  await trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId: messageId! });
  await remindCustomer({ ...world.deps, now: at("2026-11-24T05:30:00Z") }, { customerId: nordpart.customerId, localDate: "2026-11-24" });
  const { rows } = await db.pool.query("SELECT id FROM invoices WHERE customer_id = $1", [nordpart.customerId]);
  return rows[0].id as string;
}

describe("The owner chooses which mail gets a reply draft", () => {
  it("drafts for every business mail by default", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    expect((await nordpart.scope.getCustomer()).replyDrafts).toBe("all");
    const id = await receive(world, nordpart, toInbound(quoteFixture("q08"))); // asks about a delivery date
    expect(world.outlook.drafts).toHaveLength(1);
    expect(await outcomeOf(nordpart, id)).toBe("drafted:outlook");
  });

  it("with \"sales mail only\": an offer and an order confirmation, but no draft for an ordinary question", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await giveNordpartPriceList(nordpart.scope);
    await choose(nordpart, "sales");

    // A question about a delivery date: classified, looked at, left to the owner.
    const question = await receive(world, nordpart, toInbound(quoteFixture("q08")));
    expect(world.outlook.drafts).toHaveLength(0);
    expect(world.ai.of("reply-draft")).toHaveLength(0);
    expect(await outcomeOf(nordpart, question)).toBe("no_draft:not_selected");
    expect(await draftRows(nordpart, question)).toBe(0); // the reserved slot was given back
    expect((await nordpart.scope.getMessage(question))!.classification).toBe("business");

    // A quote request still gets its offer, and the acceptance its order confirmation.
    const request = await receive(world, nordpart, toInbound(quoteFixture("q01")));
    expect(await outcomeOf(nordpart, request)).toBe("offer:outlook");
    const acceptance = await receive(world, nordpart, toInbound(quoteFixture("q09")));
    expect(await outcomeOf(nordpart, acceptance)).toBe("order:outlook");
    expect(world.outlook.drafts.map((d) => d.attachments.length)).toEqual([1, 1]);
    expect(world.mailer.sent).toHaveLength(0);
  });

  it("with \"sales mail only\": a reply about an invoice being chased still gets a draft", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await choose(nordpart, "sales");
    await chaseInvoice(world, nordpart);

    const promise = await receive(world, nordpart, toInbound(paymentFixture("p02")), "2026-11-25T09:05:00Z"); // "we will pay next week"
    expect(await outcomeOf(nordpart, promise)).toBe("drafted:outlook");
    expect(world.outlook.drafts.at(-1)!.providerMessageId).toBe("graph-p02");
  });

  it("with \"none\": no reply drafts and no offers, but \"we paid\" still stops the reminders", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    await giveNordpartPriceList(nordpart.scope);
    await choose(nordpart, "off");
    const invoiceId = await chaseInvoice(world, nordpart);
    expect(world.outlook.chaserDrafts).toHaveLength(1); // payment reminders are a separate feature and still run

    const request = await receive(world, nordpart, toInbound(quoteFixture("q01")));
    expect(await outcomeOf(nordpart, request)).toBe("no_draft:switched_off");
    expect(await draftRows(nordpart, request)).toBe(0);
    expect(world.pdf.pages).toHaveLength(0);
    expect(world.ai.of("quote-request")).toHaveLength(0);

    const paid = await receive(world, nordpart, toInbound(paymentFixture("p01")), "2026-11-26T09:05:00Z");
    expect(await outcomeOf(nordpart, paid)).toBe("no_draft:switched_off");
    expect(await nordpart.scope.getInvoice(invoiceId)).toMatchObject({ status: "paid", endedBy: "sender" });
    expect(world.outlook.drafts).toHaveLength(0);
    expect(world.mailer.sent).toHaveLength(0);
  });
});
