import { ingestOutbound } from "@adminwise/core";
import type { Db } from "@adminwise/db";
import { acceptedForward, envelopeSender, type InboundMessage } from "@adminwise/mail";
import { recipientLooksLikeBuyer } from "@adminwise/offers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendBrief } from "../src/jobs/brief";
import { trackSentInvoices } from "../src/jobs/invoices";
import { remindCustomer } from "../src/jobs/reminders";
import { company, createNordpart, invoiceFixture, invoicePdf, makeWorld, openTestDb } from "./helpers";

/**
 * Ramon's decisions on the independent review (2026-11-24, report section B):
 * accepted senders for the forwarding address, an invoice mailed to someone
 * who is not the buyer, a skipped follow-up that does not count, and the
 * reminder that waits for the previous one.
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

describe("who may send to the forwarding address", () => {
  const own = new Set(["owner@nordpart.example", "office@nordpart.example", "owner.private@gmail.com"]);
  const spf = (value: string) => [{ Name: "Received-SPF", Value: value }];
  const pass = (envelope: string) => spf(`Pass (sender SPF authorized) identity=mailfrom; client-ip=1.2.3.4; envelope-from=${envelope}; receiver=x`);

  it("takes mail one of the customer's own addresses wrote or forwarded by hand", () => {
    const mail = { FromFull: { Email: "Owner@nordpart.example" }, Headers: pass("owner@nordpart.example") };
    expect(acceptedForward(mail, own)).toEqual({ accepted: true, byHand: true, why: null });
    // An address the customer added in settings counts the same.
    expect(acceptedForward({ FromFull: { Email: "office@nordpart.example" }, Headers: pass("office@nordpart.example") }, own).accepted).toBe(true);
  });

  it("refuses a stranger who guessed the address", () => {
    const mail = { FromFull: { Email: "someone@elsewhere.example" }, Headers: pass("someone@elsewhere.example") };
    expect(acceptedForward(mail, own)).toEqual({ accepted: false, byHand: false, why: "not_listed" });
  });

  it("refuses a stranger who writes the owner's address in the From line", () => {
    const forged = { FromFull: { Email: "owner@nordpart.example" }, Headers: pass("evil@attacker.example") };
    // The refusal says why, so the owner is not left guessing.
    expect(acceptedForward(forged, own)).toEqual({ accepted: false, byHand: false, why: "check_failed" });
    const failed = { FromFull: { Email: "owner@nordpart.example" }, Headers: spf("Fail (not authorized) identity=mailfrom; envelope-from=owner@nordpart.example") };
    expect(acceptedForward(failed, own).accepted).toBe(false);
  });

  it("takes mail an automatic forwarding rule of a listed mailbox passed on, and knows it was not by hand", () => {
    // Gmail forwards with the original writer in the From line and itself as the envelope sender.
    const auto = { FromFull: { Email: "buyer@rolmet.example" }, Headers: pass("owner.private+caf_=nordpart=in.getadminwise.com@gmail.com") };
    expect(envelopeSender(auto)).toBe("owner.private@gmail.com");
    expect(acceptedForward(auto, own)).toEqual({ accepted: true, byHand: false, why: null });
    // The same rule in a mailbox that is not on the list: refused.
    const other = { FromFull: { Email: "buyer@rolmet.example" }, Headers: pass("stranger+caf_=nordpart=in.getadminwise.com@gmail.com") };
    expect(acceptedForward(other, own).accepted).toBe(false);
  });

  it("the list is kept per customer, lower case, without doubles", async () => {
    const a = await createNordpart(db);
    const b = await createNordpart(db);
    await a.scope.addAcceptedSender("Office@Nordpart.example");
    await a.scope.addAcceptedSender("office@nordpart.example");
    expect((await a.scope.listAcceptedSenders()).map((s) => s.address)).toEqual(["office@nordpart.example"]);
    expect(await b.scope.listAcceptedSenders()).toEqual([]);
    // Another customer cannot remove it.
    const [entry] = await a.scope.listAcceptedSenders();
    await b.scope.removeAcceptedSender(entry!.id);
    expect(await a.scope.listAcceptedSenders()).toHaveLength(1);
    await a.scope.removeAcceptedSender(entry!.id);
    expect(await a.scope.listAcceptedSenders()).toEqual([]);
  });

  it("refused mail is told to the owner in the brief, with where to add an address", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db, { briefStartDate: "2026-11-01" });
    for (const why of ["not_listed", "check_failed"]) {
      const runId = await nordpart.scope.startJobRun("forwarding-intake");
      await nordpart.scope.finishJobRun(runId, { status: "skipped", outcome: `refused_sender:${why}` });
    }
    await db.pool.query("UPDATE job_runs SET started_at = '2026-11-17T10:00:00Z' WHERE customer_id = $1 AND job = 'forwarding-intake'", [nordpart.customerId]);
    await sendBrief({ ...world.deps, now: at("2026-11-18T06:30:00Z") }, { customerId: nordpart.customerId, localDate: "2026-11-18" });
    const brief = world.mailer.sent.at(-1)!.textBody;
    expect(brief).toContain("- 2 email(s) sent to your forwarding address yesterday were refused");
    expect(brief).toContain("add the address here: https://app.test/settings");
  });
});

describe("was the invoice mailed to the buyer", () => {
  it("compares the buyer's name with the recipient's domain, loosely", () => {
    expect(recipientLooksLikeBuyer("Rolmet sp. z o.o.", "rolmet.example", false)).toBe(true);
    expect(recipientLooksLikeBuyer("Halvorsen Maskin AS", "halvorsen-maskin.example", false)).toBe(true);
    expect(recipientLooksLikeBuyer("Zakład Usług Rolnych Jan Kowalski", "zur-kowalski.pl", false)).toBe(true);
    expect(recipientLooksLikeBuyer("Przedsiębiorstwo Handlowe Agro-Mlek", "phagromlek.com.pl", false)).toBe(true);
    // The owner's accountant.
    expect(recipientLooksLikeBuyer("Rolmet sp. z o.o.", "biuro-lipka.example", false)).toBe(false);
    // Nothing to compare: no opinion, so nothing is asked.
    expect(recipientLooksLikeBuyer("Rolmet sp. z o.o.", "gmail.com", true)).toBeNull();
    expect(recipientLooksLikeBuyer("", "rolmet.example", false)).toBeNull();
    expect(recipientLooksLikeBuyer("Rolmet sp. z o.o.", "", false)).toBeNull();
  });
});

/** Nordpart mails invoice i01 (made out to Rolmet sp. z o.o.) to this address. */
async function sendInvoiceTo(world: World, nordpart: Nordpart, key: string, to: string) {
  const file = { name: invoiceFixture("i01").file, bytes: invoicePdf("i01") };
  const message: InboundMessage = {
    providerMessageId: `graph-dec-${key}`,
    internetMessageId: `<dec-${key}@nordpart.example>`,
    threadKey: `thr-dec-${key}`,
    subject: `Faktura ${key}`,
    from: { address: company.mailbox, name: company.name },
    receivedAt: new Date("2026-11-03T10:00:00Z"),
    bodyText: "Dzień dobry,\n\nw załączeniu faktura.\n\nPozdrawiam\nTomasz",
    headerFlags: {},
    attachmentNames: [file.name],
    to: [to],
    cc: [],
  };
  world.outlook.mailbox.set(message.providerMessageId, message);
  world.outlook.attachments.set(message.providerMessageId, [
    { info: { id: `att-${key}`, name: file.name, contentType: "application/pdf", sizeBytes: file.bytes.byteLength, isInline: false }, bytes: file.bytes },
  ]);
  const { messageId } = await ingestOutbound(nordpart.scope, nordpart.microsoftId, message, world.queue);
  const outcome = await trackSentInvoices(world.deps, { customerId: nordpart.customerId, messageId: messageId! });
  const { rows } = await db.pool.query("SELECT id FROM invoices WHERE customer_id = $1 AND message_id = $2", [nordpart.customerId, messageId]);
  return { outcome, invoiceId: rows[0].id as string };
}
const remind = (world: World, nordpart: Nordpart, localDate: string) =>
  remindCustomer({ ...world.deps, now: at(`${localDate}T05:30:00Z`) }, { customerId: nordpart.customerId, localDate });

describe("an invoice mailed to the accountant", () => {
  it("is not chased: the owner is asked once, and decides", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db, { briefStartDate: "2026-11-01" });
    const { outcome, invoiceId } = await sendInvoiceTo(world, nordpart, "acc", "anna@biuro-lipka.example");
    expect(outcome).toBe("needs_confirm:1");
    expect(await nordpart.scope.getInvoice(invoiceId)).toMatchObject({ status: "needs_confirm", number: "FV/2026/11/0457", dueDate: "2026-11-17", debtorDomain: "biuro-lipka.example" });

    // No reminder, however late it gets.
    expect((await remind(world, nordpart, "2026-11-24")).reminders).toBe(0);
    expect(world.outlook.chaserDrafts).toHaveLength(0);

    // Asked once in the brief.
    await sendBrief({ ...world.deps, now: at("2026-11-25T06:30:00Z") }, { customerId: nordpart.customerId, localDate: "2026-11-25" });
    const brief = world.mailer.sent.at(-1)!.textBody;
    expect(brief).toContain("- Invoice FV/2026/11/0457 for Rolmet sp. z o.o. (26 372,43 PLN) was mailed to biuro-lipka.example, which does not look like the buyer");
    await sendBrief({ ...world.deps, now: at("2026-11-26T06:30:00Z") }, { customerId: nordpart.customerId, localDate: "2026-11-26" });
    expect(world.mailer.sent.at(-1)!.textBody).not.toContain("does not look like the buyer");

    // "Yes, they should be reminded": from then on it is an ordinary tracked invoice.
    expect(await nordpart.scope.confirmInvoice(invoiceId)).toBe(true);
    expect((await nordpart.scope.getInvoice(invoiceId))!.status).toBe("open");
    expect((await remind(world, nordpart, "2026-11-27")).reminders).toBe(1);
    // Asking again changes nothing.
    expect(await nordpart.scope.confirmInvoice(invoiceId)).toBe(false);
  });

  it("\"no, do not track\" ends it; an invoice mailed to the buyer is tracked without asking", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db);
    const copy = await sendInvoiceTo(world, nordpart, "copy", "anna@biuro-lipka.example");
    expect(await nordpart.scope.endInvoice(copy.invoiceId, "stopped", "owner", new Date())).toBe(true);
    expect((await nordpart.scope.getInvoice(copy.invoiceId))!.status).toBe("stopped");

    const other = await createNordpart(db);
    expect((await sendInvoiceTo(world, other, "buyer", "ksiegowosc@rolmet.example")).outcome).toBe("open:1");
    // A private mailbox says nothing about who it belongs to: tracked as before.
    const third = await createNordpart(db);
    expect((await sendInvoiceTo(world, third, "gmail", "jan.kowalski@gmail.com")).outcome).toBe("open:1");
  });
});

describe("the reminder that waits for the previous one", () => {
  it("is said in the brief on the day the next one was due", async () => {
    const world = makeWorld(db);
    const nordpart = await createNordpart(db, { briefStartDate: "2026-11-01" });
    const { invoiceId } = await sendInvoiceTo(world, nordpart, "wait", "ksiegowosc@rolmet.example");
    expect((await remind(world, nordpart, "2026-11-24")).reminders).toBe(1);

    // Reminder 1 stays unsent. A week later reminder 2 is due, and is not prepared.
    expect((await remind(world, nordpart, "2026-12-01")).reminders).toBe(0);
    expect((await nordpart.scope.getInvoice(invoiceId))!.reminderBlockedOn).toBe("2026-12-01");
    await sendBrief({ ...world.deps, now: at("2026-12-01T06:30:00Z") }, { customerId: nordpart.customerId, localDate: "2026-12-01" });
    expect(world.mailer.sent.at(-1)!.textBody).toContain("  Reminder 1 of 3 is still in your Outlook Drafts, unsent. The next one is prepared once it has been sent or deleted.");

    // The owner sends it: the next run prepares reminder 2 and the note is gone.
    world.outlook.waitingDrafts.delete(world.outlook.chaserDrafts[0]!.id);
    expect((await remind(world, nordpart, "2026-12-02")).reminders).toBe(1);
    expect((await nordpart.scope.getInvoice(invoiceId))!.reminderBlockedOn).toBeNull();
  });
});

describe("a follow-up that was skipped", () => {
  it("is counted apart, and never more than there were drafts", async () => {
    const nordpart = await createNordpart(db);
    const { rows } = await db.pool.query(
      `INSERT INTO threads (customer_id, provider_thread_id, subject, last_message_at, chaser_count)
       VALUES ($1, 'thr-skip', 'Oferta', now(), 1) RETURNING id`,
      [nordpart.customerId],
    );
    const threadId = rows[0].id as string;
    const thread = async () => (await nordpart.scope.getThread(threadId))!;

    // "Not this time" on a thread without a waiting draft (listed as gone quiet): nothing was skipped.
    await nordpart.scope.snoozeChase(threadId, new Date());
    expect(await thread()).toMatchObject({ chaserCount: 1, chasersUnused: 0 });
    // A draft that was written and then skipped or deleted unsent: that one does not count as a follow-up.
    await nordpart.scope.snoozeChase(threadId, new Date(), true);
    expect(await thread()).toMatchObject({ chaserCount: 1, chasersUnused: 1 });
    // Never more skipped than written.
    await nordpart.scope.snoozeChase(threadId, new Date(), true);
    expect(await thread()).toMatchObject({ chaserCount: 1, chasersUnused: 1 });
  });
});
