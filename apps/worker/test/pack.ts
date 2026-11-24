import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AiClient, AiRequest, AiResult } from "@adminwise/ai";
import { addDays, ingestInbound, ingestOutbound, QUEUES, startOfLocalDay } from "@adminwise/core";
import { forCustomer, system, type CustomerScope, type Db, type OfferSettings, type ReplyDraftMode } from "@adminwise/db";
import { flagsFromHeaders, type InboundMessage } from "@adminwise/mail";
import { importPriceList } from "@adminwise/offers";
import type { Deps } from "../src/deps";
import { sendBrief } from "../src/jobs/brief";
import { chaseCustomer } from "../src/jobs/chaser";
import { fileAttachments } from "../src/jobs/filing";
import { trackSentInvoices } from "../src/jobs/invoices";
import { remindCustomer } from "../src/jobs/reminders";
import { FakeMailer, FakeOutlook, FakePdf, MemoryQueue, PHASE1_SCOPES } from "./helpers";

/**
 * A "company pack": one invented company in fixtures/<slug>/, with a month of
 * mail and what should happen to each piece of it. `runMonth` plays the whole
 * month through the real jobs, day by day, with a model stand-in that answers
 * from the pack. The tests then compare what happened with what was expected.
 */

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

export interface PackMail {
  id: string;
  at: string;
  from: { address: string; name: string };
  subject: string;
  thread?: string;
  headers?: { name: string; value: string }[];
  attachments?: string[];
  twice?: boolean;
  body: string;
  what: string;
  expected: {
    category: string;
    language: string | null;
    decidedBy: "rule" | "model";
    suspicious?: boolean;
    flaggedBy?: "model" | "wording";
    unlistedLanguage?: boolean;
    /** drafted | offer | clarify | order | none:<reason> */
    outcome: string;
    quote?: { isQuote: boolean; items: { request: string; quantity: number | null; unit: string | null }[] };
    matches?: { request: string; result: "match" | "ambiguous" | "none"; code: string | null }[];
    offerLines?: { code: string; quantity: number }[];
    discountPercent?: number;
    accepts?: boolean;
    paid?: boolean;
    covers: string[];
  };
}
export interface PackSent {
  id: string;
  at: string;
  to: string[];
  subject: string;
  thread?: string;
  invoice?: string;
  body: string;
  what: string;
  expectsReply: boolean;
  followUps: number;
}
export interface PackAttachment {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  inline: boolean;
  seed: string;
  expected: { result: "filed" | "duplicate" | "skipped" | "none"; type: string | null; decidedBy: string; counter?: number };
}
export interface PackInvoice {
  id: string;
  file: string;
  expected: { status: string; number?: string; amountCents?: number; currency?: string; dueDate?: string | null; buyer?: string; reminders: number; endStatus: string };
  recorded: Record<string, unknown> | null;
}
export interface Pack {
  slug: string;
  dir: string;
  company: {
    name: string; slug: string; domain: string; ownerEmail: string; mailbox: string; languages: string[]; timeZone: string;
    followUpDays: number; replyDrafts?: ReplyDraftMode; signatureText: string; voiceProfile: string; offer: OfferSettings;
    discounts: { match: string; percent: number }[];
    priceList: { file: string; fileName: string; validItems: number; skippedRows: number };
    period: { from: string; to: string };
  };
  prices: Map<string, number>;
  mail: PackMail[];
  sent: PackSent[];
  events: { at: string; action: "never"; sent: string }[];
  attachments: PackAttachment[];
  invoices: PackInvoice[];
  thread: { threadKey: string; subject: string; messages: { direction: "inbound" | "outbound"; from: string; at: string; body: string }[] };
}

export function loadPack(slug: string): Pack {
  const dir = path.join(fixturesRoot, slug);
  const read = <T>(name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;
  const list = read<{ rows: (string | number)[][] }>("price-list.json");
  // The first row with a code wins, as at upload; rows without a number as price are left out.
  const prices = new Map<string, number>();
  for (const [code, , , price] of list.rows) {
    if (typeof price === "number" && !prices.has(String(code))) prices.set(String(code), Math.round(price * 100));
  }
  const sent = read<{ sent: PackSent[]; events?: Pack["events"] }>("sent.json");
  return {
    slug,
    dir,
    company: read("company.json"),
    prices,
    mail: read<{ mail: PackMail[] }>("mail.json").mail,
    sent: sent.sent,
    events: sent.events ?? [],
    attachments: read<{ attachments: PackAttachment[] }>("attachments.json").attachments,
    invoices: read<{ invoices: PackInvoice[] }>("invoices.json").invoices,
    thread: read("thread-long.json"),
  };
}

const providerId = (id: string) => `graph-${id}`;
const threadOf = (item: { id: string; thread?: string }) => item.thread ?? `thr-${item.id}`;

/** The bytes of an attachment: made from its seed, so the same seed is the same file. */
export function packBytes(a: PackAttachment): Uint8Array {
  const header = a.contentType === "application/pdf" ? "%PDF-1.4\n" : "";
  const line = `% Adminwise test fixture: ${a.seed}\n`;
  return new Uint8Array(Buffer.from(header + line.repeat(Math.ceil(a.sizeBytes / line.length)), "latin1").subarray(0, a.sizeBytes));
}

function inboundOf(pack: Pack, mail: PackMail): InboundMessage {
  return {
    providerMessageId: providerId(mail.id),
    internetMessageId: `<${mail.id.toLowerCase()}@${mail.from.address.split("@")[1]}>`,
    threadKey: threadOf(mail),
    subject: mail.subject,
    from: mail.from,
    receivedAt: new Date(mail.at),
    bodyText: mail.body,
    headerFlags: flagsFromHeaders(mail.headers ?? []),
    attachmentNames: (mail.attachments ?? []).map((id) => pack.attachments.find((a) => a.id === id)!.name),
  };
}
function outboundOf(pack: Pack, sent: PackSent): InboundMessage {
  const invoice = sent.invoice ? pack.invoices.find((i) => i.id === sent.invoice)! : null;
  return {
    providerMessageId: providerId(sent.id),
    internetMessageId: `<${sent.id.toLowerCase()}@${pack.company.domain}>`,
    threadKey: threadOf(sent),
    subject: sent.subject,
    from: { address: pack.company.mailbox, name: pack.company.name },
    receivedAt: new Date(sent.at),
    bodyText: sent.body,
    headerFlags: {},
    attachmentNames: invoice ? [invoice.file] : [],
    to: sent.to,
    cc: [],
  };
}

const CANNED: Record<string, string> = {
  pl: "Dzień dobry,\n\ndziękuję za wiadomość. [do uzupełnienia]\n\nPozdrawiam",
  en: "Hello,\n\nthank you for your message. [to be completed]\n\nKind regards",
  nl: "Hoi,\n\ndank voor je bericht. [aan te vullen]\n\nGroet",
  de: "Guten Tag,\n\nvielen Dank für Ihre Nachricht. [zu ergänzen]\n\nMit freundlichen Grüßen",
  uk: "Добрий день,\n\nдякую за повідомлення. [доповнити]\n\nЗ повагою",
  fr: "Bonjour,\n\nmerci pour votre message. [à compléter]\n\nCordialement",
};

/**
 * Stands in for the model, answering from the pack's "expected" values. It
 * throws when asked something the pack says should never reach the model (for
 * example to sort a mail that a rule decides), so such a call fails the test.
 */
export class PackAi implements AiClient {
  requests: AiRequest[] = [];
  constructor(private readonly pack: Pack) {}

  private mailIn(text: string): PackMail | undefined {
    return this.pack.mail.find((m) => text.includes(m.body));
  }

  async complete(request: AiRequest): Promise<AiResult> {
    this.requests.push(request);
    const answer = (value: unknown, tokens = 100): AiResult => ({ text: typeof value === "string" ? value : JSON.stringify(value), inputTokens: tokens, outputTokens: 20 });
    const language = /Write in this language: ([a-z]{2})/.exec(request.system)?.[1] ?? "en";
    const mail = this.mailIn(request.user);

    switch (request.job) {
      case "classify": {
        if (!mail) throw new Error("Asked to sort a mail that is not in the pack");
        if (mail.expected.decidedBy === "rule") throw new Error(`${mail.id} should be decided by a rule, but the model was asked`);
        return answer({
          category: mail.expected.category,
          language: mail.expected.language,
          // "wording" cases answer no on purpose: the phrase check must catch them alone.
          instructs_assistant: mail.expected.suspicious && mail.expected.flaggedBy === "model" ? "yes" : "no",
        });
      }
      case "quote-request": {
        const quote = mail?.expected.quote ?? { isQuote: false, items: [] };
        return answer({ is_quote_request: quote.isQuote ? "yes" : "no", items: quote.items });
      }
      case "match-items": {
        const known = this.pack.mail.flatMap((m) => m.expected.matches ?? []);
        const blocks = request.user.split(/\n\n(?=Requested item \d+:)/);
        const matches = blocks.map((block, index) => {
          const found = known.find((m) => block.includes(`\n${m.request}\n`));
          if (!found) throw new Error(`No expected match for requested item: ${block.slice(0, 160)}`);
          const line = found.code ? new RegExp(`^\\s+(\\d+)\\. ${found.code} \\|`, "m").exec(block) : null;
          if (found.result === "match" && !line) throw new Error(`"${found.request}": ${found.code} was not among the candidates shown to the model`);
          return { item: index + 1, result: found.result, candidate: line ? Number(line[1]) : null };
        });
        return answer({ matches });
      }
      case "offer-acceptance":
        return answer({ accepts: mail?.expected.accepts ? "yes" : "no" });
      case "payment-notice":
        return answer({ paid: mail?.expected.paid ? "yes" : "no" });
      case "chaser-check": {
        // A follow-up the owner sent is itself a mail that expects an answer.
        if (Object.values(CANNED).some((text) => request.user.includes(text))) return answer({ expects_reply: "yes" });
        const sent = this.pack.sent.find((s) => request.user.includes(s.body));
        if (!sent) throw new Error("Asked about a sent mail that is not in the pack");
        return answer({ expects_reply: sent.expectsReply ? "yes" : "no" });
      }
      case "file-type": {
        const file = this.pack.attachments.find((a) => a.expected.decidedBy === "model" && request.user.includes(a.name));
        if (!file) throw new Error("Asked for the type of a file whose name should have decided it");
        return answer({ type: file.expected.type });
      }
      case "invoice-fields": {
        const invoice = this.pack.invoices.find((i) => i.recorded && request.user.includes(String(i.recorded.number)));
        return answer(invoice?.recorded ?? { is_invoice: "no", issued_by_company: "no" }, 500);
      }
      case "reply-draft":
      case "quote-reply":
      case "order-reply":
      case "chaser-draft":
      case "payment-reminder":
        return answer(CANNED[language] ?? CANNED.en!, 600);
      default:
        throw new Error(`The pack has no answer for job "${request.job}"`);
    }
  }

  of(job: string): AiRequest[] {
    return this.requests.filter((r) => r.job === job);
  }
}

export interface MonthResult {
  pack: Pack;
  db: Db;
  customerId: string;
  ownerEmail: string;
  scope: CustomerScope;
  ai: PackAi;
  outlook: FakeOutlook;
  mailer: FakeMailer;
  pdf: FakePdf;
  briefs: { date: string; text: string }[];
}

/** Plays the pack's whole period through the real jobs. */
export async function runMonth(db: Db, pack: Pack): Promise<MonthResult> {
  const c = pack.company;
  const tag = randomBytes(4).toString("hex");
  const ownerEmail = c.ownerEmail.replace("@", `.${tag}@`);
  const { customerId } = await system(db).createCustomerWithUser({
    email: ownerEmail,
    slug: `${c.slug}-${tag}`,
    timeZone: c.timeZone,
    briefStartDate: addDays(c.period.from, -1),
  });
  const scope = forCustomer(db, customerId);
  await scope.updateSettings({ name: c.name, languages: c.languages, timeZone: c.timeZone, signatureText: c.signatureText, followUpDays: c.followUpDays, replyDrafts: c.replyDrafts ?? "all" });
  await scope.setVoiceProfile(c.voiceProfile);
  const microsoft = await scope.upsertConnection({
    provider: "microsoft", emailAddress: c.mailbox, accessToken: "test-access-token", refreshToken: "test-refresh-token",
    tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: `${PHASE1_SCOPES} Files.ReadWrite.AppFolder`,
  });

  const ai = new PackAi(pack);
  const outlook = new FakeOutlook();
  const mailer = new FakeMailer();
  const queue = new MemoryQueue();
  const pdf = new FakePdf();
  const base: Deps = { db, queue, ai, mailer, outlook, pdf, appName: "Adminwise", appBaseUrl: "https://app.test" };
  const depsAt = (when: Date): Deps => ({ ...base, now: () => when });
  const plus = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000);

  // The price list is read from its column titles alone: the model is not needed.
  const list = await importPriceList(scope, { complete: async () => { throw new Error("the column titles should have been enough"); } }, {
    fileName: c.priceList.fileName, bytes: new Uint8Array(readFileSync(path.join(pack.dir, c.priceList.file))), currency: c.offer.currency,
  });
  if (list.itemCount !== c.priceList.validItems || list.skippedCount !== c.priceList.skippedRows) {
    throw new Error(`${pack.slug}: price list read as ${list.itemCount} items and ${list.skippedCount} skipped rows`);
  }
  await scope.activatePriceList(list.priceListId);
  await scope.updateOfferSettings(c.offer);
  for (const d of c.discounts) await scope.setDiscount(d.match, d.percent);

  // The earlier messages of the long conversation are already in the mailbox.
  const silent = new MemoryQueue();
  for (const [index, m] of pack.thread.messages.entries()) {
    const message: InboundMessage = {
      providerMessageId: providerId(`long-${index}`), internetMessageId: `<long-${index}@${pack.slug}.example>`, threadKey: pack.thread.threadKey,
      subject: pack.thread.subject, from: { address: m.from, name: "" }, receivedAt: new Date(m.at), bodyText: m.body, headerFlags: {}, attachmentNames: [], to: [], cc: [],
    };
    if (m.direction === "inbound") await ingestInbound(scope, silent, microsoft.id, message);
    else await ingestOutbound(scope, microsoft.id, { ...message, from: { address: c.mailbox, name: c.name } });
  }

  type Step = { at: string; run: () => Promise<void> };
  const steps: Step[] = [];
  for (const mail of pack.mail) {
    steps.push({
      at: mail.at,
      run: async () => {
        const message = inboundOf(pack, mail);
        outlook.mailbox.set(message.providerMessageId, message);
        outlook.attachments.set(
          message.providerMessageId,
          (mail.attachments ?? []).map((id) => {
            const a = pack.attachments.find((x) => x.id === id)!;
            return { info: { id: `att-${mail.id}-${a.id}`, name: a.name, contentType: a.contentType, sizeBytes: a.sizeBytes, isInline: a.inline }, bytes: packBytes(a) };
          }),
        );
        for (let copy = 0; copy < (mail.twice ? 2 : 1); copy++) await ingestInbound(scope, queue, microsoft.id, message);
        await queue.drain(depsAt(plus(mail.at, 2)));
        for (const job of queue.of(QUEUES.fileAttachments)) await fileAttachments(depsAt(plus(mail.at, 3)), job);
        queue.jobs = queue.jobs.filter((j) => j.queue !== QUEUES.fileAttachments);
      },
    });
  }
  for (const sent of pack.sent) {
    steps.push({
      at: sent.at,
      run: async () => {
        const message = outboundOf(pack, sent);
        outlook.mailbox.set(message.providerMessageId, message);
        if (sent.invoice) {
          const invoice = pack.invoices.find((i) => i.id === sent.invoice)!;
          const bytes = new Uint8Array(readFileSync(path.join(pack.dir, "invoices", invoice.file)));
          outlook.attachments.set(message.providerMessageId, [
            { info: { id: `att-${sent.id}`, name: invoice.file, contentType: "application/pdf", sizeBytes: bytes.byteLength, isInline: false }, bytes },
          ]);
        }
        await ingestOutbound(scope, microsoft.id, message, queue);
        for (const job of queue.of(QUEUES.trackInvoices)) await trackSentInvoices(depsAt(plus(sent.at, 2)), job);
        queue.jobs = queue.jobs.filter((j) => j.queue !== QUEUES.trackInvoices);
      },
    });
  }
  for (const event of pack.events) {
    steps.push({
      at: event.at,
      run: async () => {
        const { rows } = await db.pool.query("SELECT thread_id FROM messages WHERE customer_id = $1 AND provider_message_id = $2", [customerId, providerId(event.sent)]);
        await scope.setChaseMode(rows[0].thread_id as string, "never");
      },
    });
  }
  steps.sort((a, b) => a.at.localeCompare(b.at));

  // What happened before the period (an invoice sent two weeks earlier) is taken in first.
  const periodStart = startOfLocalDay(c.period.from, c.timeZone);
  let next = 0;
  while (next < steps.length && new Date(steps[next]!.at) < periodStart) await steps[next++]!.run();

  const briefs: MonthResult["briefs"] = [];
  for (let date = c.period.from; date <= c.period.to; date = addDays(date, 1)) {
    const dayStart = startOfLocalDay(date, c.timeZone);
    const nightly = new Date(dayStart.getTime() + 6 * 3_600_000);
    await chaseCustomer(depsAt(nightly), { customerId, localDate: date });
    await remindCustomer(depsAt(nightly), { customerId, localDate: date });
    await sendBrief(depsAt(new Date(dayStart.getTime() + 7.5 * 3_600_000)), { customerId, localDate: date });
    briefs.push({ date, text: mailer.sent.at(-1)!.textBody });
    // The owner reads the brief and sends what was waiting in Drafts. A sent follow-up shows up in
    // Sent Items like any other mail (one that is deleted instead would not count as a follow-up).
    for (const open of await scope.listOpenChasers()) {
      const draft = outlook.chaserDrafts.find((d) => d.id === open.providerDraftId);
      const original = draft ? outlook.mailbox.get(draft.sentMessageId) : undefined;
      if (!draft || !original || !outlook.waitingDrafts.has(draft.id)) continue;
      const followUp: InboundMessage = {
        ...original,
        providerMessageId: `sent-${customerId}-${draft.id}`,
        internetMessageId: `<sent-${draft.id}@${c.domain}>`,
        subject: /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
        receivedAt: new Date(dayStart.getTime() + 8.5 * 3_600_000),
        bodyText: draft.text,
        attachmentNames: [],
        to: draft.to,
        cc: draft.cc,
      };
      outlook.mailbox.set(followUp.providerMessageId, followUp);
      await ingestOutbound(scope, microsoft.id, followUp);
    }
    outlook.waitingDrafts.clear();

    const dayEnd = startOfLocalDay(addDays(date, 1), c.timeZone);
    while (next < steps.length && new Date(steps[next]!.at) < dayEnd) await steps[next++]!.run();
  }
  return { pack, db, customerId, ownerEmail, scope, ai, outlook, mailer, pdf, briefs };
}

/** What became of one incoming mail. */
export async function mailOutcome(result: MonthResult, mail: PackMail) {
  const { db, customerId } = result;
  const { rows } = await db.pool.query(
    "SELECT id, classification, language, suspicious FROM messages WHERE customer_id = $1 AND provider_message_id = $2",
    [customerId, providerId(mail.id)],
  );
  if (rows.length !== 1) return { stored: rows.length, category: null, language: null, suspicious: null, outcome: null, messageId: null };
  const message = rows[0] as { id: string; classification: string | null; language: string | null; suspicious: boolean };
  const runs = await db.pool.query("SELECT status, outcome FROM job_runs WHERE customer_id = $1 AND job = 'reply-draft' AND ref = $2 ORDER BY started_at", [customerId, message.id]);
  // The first run decided; a second delivery of the same mail is "skipped".
  const first = runs.rows[0] as { status: string; outcome: string | null } | undefined;
  const raw = first?.outcome ?? first?.status ?? "";
  const outcome = raw.startsWith("no_draft:") ? `none:${raw.slice(9)}` : raw.split(":")[0]!;
  return { stored: 1, category: message.classification, language: message.language, suspicious: message.suspicious, outcome, messageId: message.id, runs: runs.rows.length };
}
