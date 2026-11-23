import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AiClient, AiRequest, AiResult } from "@adminwise/ai";
import { QUEUES, type JobPayloads, type JobQueue, type OutlookGateway, type QueueName } from "@adminwise/core";
import { createDb, forCustomer, system, type CustomerScope, type Db, type OfferSettings } from "@adminwise/db";
import { importPriceList } from "@adminwise/offers";
import {
  domainOf,
  flagsFromHeaders,
  GraphError,
  type AttachmentInfo,
  type InboundMessage,
  type OutboundAttachment,
  type OutboundEmail,
  type OutboundMailer,
} from "@adminwise/mail";
import { inject } from "vitest";
import type { Deps, PdfRenderer } from "../src/deps";
import { processMessage } from "../src/jobs/process-message";

// ---- fixtures ----------------------------------------------------------------

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/nordpart");
const readJson = <T>(name: string) => JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as T;

export interface FixtureEmail {
  id: string;
  messageId: string;
  threadKey: string;
  from: { address: string; name: string };
  subject: string;
  receivedAt: string;
  headers: { name: string; value: string }[];
  attachmentNames: string[];
  bodyText: string;
  expected: {
    category: string;
    language: string | null;
    decidedBy: "rule" | "model";
    /** Phase 3: what the model reports for a quote request, and which candidate it picks for items without a code. */
    quote?: { isQuote: boolean; items: { request: string; quantity: number | null; unit: string | null }[] };
    matches?: { request: string; result: "match" | "ambiguous" | "none"; code: string | null }[];
    /** Whether this reply accepts the open offer in its conversation. */
    accepts?: boolean;
  };
}

export const company = readJson<{
  name: string;
  slug: string;
  domain: string;
  mailbox: string;
  languages: string[];
  timeZone: string;
  signatureText: string;
  voiceProfile: string;
}>("company.json");
export const inbound = readJson<FixtureEmail[]>("inbound.json");
/** Phase 3: quote requests, with the answers the recorded model gives for them. */
export const quotes = readJson<FixtureEmail[]>("quotes.json");
export const quoteFixture = (id: string): FixtureEmail => {
  const found = quotes.find((f) => f.id === id);
  if (!found) throw new Error(`No quote fixture ${id}`);
  return found;
};
const recorded = (): FixtureEmail[] => [...inbound, ...quotes];
/** The fixture a model request is about: the one whose subject it contains (the longest, as a reply's subject contains the original's). */
const bySubject = (text: string, list: FixtureEmail[]): FixtureEmail | undefined =>
  list.filter((f) => text.includes(f.subject)).sort((a, b) => b.subject.length - a.subject.length)[0];
export const sentEmails = readJson<{ id: string; language: string; bodyText: string }[]>("sent-emails.json");
export const longThread = readJson<{
  threadKey: string;
  subject: string;
  messages: { messageId: string; direction: "inbound" | "outbound"; from: string; receivedAt: string; bodyText: string }[];
}>("thread-long.json");

// ---- phase 2 fixtures: sent mail and attachments --------------------------------

export interface FixtureSent {
  id: string;
  messageId: string;
  threadKey: string;
  to: string[];
  cc: string[];
  subject: string;
  sentAt: string;
  bodyText: string;
  expectsReply: boolean;
}
export interface FixtureAttachment {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  inline: boolean;
  seed: string;
  expectedType: string | null;
  decidedBy: "rule" | "model" | "skipped" | "duplicate";
}
export interface FixtureFilingMail {
  id: string;
  messageId: string;
  threadKey: string;
  from: { address: string; name: string };
  subject: string;
  receivedAt: string;
  headers: { name: string; value: string }[];
  bodyText: string;
  attachments: string[];
}
export const phase2 = readJson<{
  sentMessages: FixtureSent[];
  attachments: FixtureAttachment[];
  filingMails: FixtureFilingMail[];
}>("phase2.json");

const byId = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`No fixture ${id}`);
  return found;
};
export const sentFixture = (id: string) => byId(phase2.sentMessages, id);
export const attachmentFixture = (id: string) => byId(phase2.attachments, id);
export const filingMail = (id: string) => byId(phase2.filingMails, id);

/** A message Nordpart sent itself, as the mailbox adapter returns it from Sent Items. */
export function toSent(f: FixtureSent, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    providerMessageId: `graph-${f.id}`,
    internetMessageId: f.messageId,
    threadKey: f.threadKey,
    subject: f.subject,
    from: { address: company.mailbox, name: company.name },
    receivedAt: new Date(f.sentAt),
    bodyText: f.bodyText,
    headerFlags: {},
    attachmentNames: [],
    to: f.to,
    cc: f.cc,
    ...overrides,
  };
}

export function toFilingInbound(f: FixtureFilingMail): InboundMessage {
  return {
    providerMessageId: `graph-${f.id}`,
    internetMessageId: f.messageId,
    threadKey: f.threadKey,
    subject: f.subject,
    from: f.from,
    receivedAt: new Date(f.receivedAt),
    bodyText: f.bodyText,
    headerFlags: flagsFromHeaders(f.headers),
    attachmentNames: f.attachments.map((id) => attachmentFixture(id).name),
  };
}

/** The bytes of a fixture file: the right size and the right first bytes, and the same for the same seed. */
export function attachmentBytes(a: FixtureAttachment): Uint8Array {
  const header = a.contentType === "application/pdf" ? "%PDF-1.4\n" : "\u0089PNG\r\n";
  const line = `% Adminwise test fixture: ${a.seed}\n`;
  const text = header + line.repeat(Math.ceil(a.sizeBytes / line.length));
  return new Uint8Array(Buffer.from(text, "latin1").subarray(0, a.sizeBytes));
}

export const fixture = (id: string): FixtureEmail => {
  const found = inbound.find((f) => f.id === id);
  if (!found) throw new Error(`No fixture ${id}`);
  return found;
};

export function toInbound(f: FixtureEmail, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    providerMessageId: `graph-${f.id}`,
    internetMessageId: f.messageId,
    threadKey: f.threadKey,
    subject: f.subject,
    from: f.from,
    receivedAt: new Date(f.receivedAt),
    bodyText: f.bodyText,
    headerFlags: flagsFromHeaders(f.headers),
    attachmentNames: f.attachmentNames,
    ...overrides,
  };
}

// ---- fakes -------------------------------------------------------------------

const CANNED_DRAFTS: Record<string, string> = {
  pl: "Dzień dobry,\n\ndziękuję za wiadomość. [potwierdzić termin]\n\nPozdrawiam",
  en: "Hello,\n\nThank you for your message. [confirm date]\n\nBest regards",
};

export const CANNED_ORDER_REPLY = "Dzień dobry,\n\ndziękuję za zamówienie, potwierdzenie przesyłam w załączeniu. [termin dostawy]\n\nPozdrawiam";

export const CANNED_QUOTE_REPLIES: Record<string, string> = {
  pl: "Dzień dobry,\n\ndziękuję za zapytanie, odpowiedź przesyłam poniżej.\n\nPozdrawiam",
  en: "Hello,\n\nThank you for your enquiry, please see my reply below.\n\nBest regards",
  cs: "Dobrý den,\n\nděkuji za poptávku, odpověď posílám níže.\n\nS pozdravem",
};

export const CANNED_CHASER ="Dzień dobry,\n\nczy mogę prosić o krótką odpowiedź na moją poprzednią wiadomość?\n\nPozdrawiam";

/**
 * Stands in for the model. Classification answers are the ones recorded in the
 * fixtures ("expected"); drafts are a fixed text per language. It records every
 * request, so tests can check exactly what the model was asked.
 */
export class RecordedAi implements AiClient {
  requests: AiRequest[] = [];

  async complete(request: AiRequest): Promise<AiResult> {
    this.requests.push(request);
    if (request.job === "quote-request") {
      const match = bySubject(request.user, recorded());
      const quote = match?.expected.quote ?? { isQuote: false, items: [] };
      return {
        text: JSON.stringify({ is_quote_request: quote.isQuote ? "yes" : "no", items: quote.items }),
        inputTokens: 300,
        outputTokens: 40,
      };
    }
    if (request.job === "match-items") {
      // Each block is "Requested item N: <email_data ...> request </email_data> Candidates ...: 1. CODE | name | ...".
      const blocks = request.user.split(/\n\n(?=Requested item \d+:)/);
      const known = quotes.flatMap((f) => f.expected.matches ?? []);
      const matches = blocks.map((block, index) => {
        const answer = known.find((m) => block.includes(`\n${m.request}\n`));
        if (!answer) throw new Error("No recorded match for this requested item");
        const line = answer.code ? new RegExp(`^\\s+(\\d+)\\. ${answer.code} \\|`, "m").exec(block) : null;
        if (answer.result === "match" && !line) throw new Error(`Candidate ${answer.code} was not offered to the model`);
        return { item: index + 1, result: answer.result, candidate: line ? Number(line[1]) : null };
      });
      return { text: JSON.stringify({ matches }), inputTokens: 400, outputTokens: 30 };
    }
    if (request.job === "offer-acceptance") {
      const match = bySubject(request.user, quotes);
      return { text: JSON.stringify({ accepts: match?.expected.accepts ? "yes" : "no" }), inputTokens: 110, outputTokens: 6 };
    }
    if (request.job === "order-reply") {
      return { text: CANNED_ORDER_REPLY, inputTokens: 450, outputTokens: 50 };
    }
    if (request.job === "quote-reply") {
      const language = /Write in this language: ([a-z]{2})/.exec(request.system)?.[1] ?? "en";
      return { text: CANNED_QUOTE_REPLIES[language] ?? CANNED_QUOTE_REPLIES.en!, inputTokens: 600, outputTokens: 80 };
    }
    if (request.job === "classify") {
      const match = bySubject(request.user, recorded());
      if (!match?.expected.language) throw new Error("No recorded classification for this email");
      return {
        text: JSON.stringify({ category: match.expected.category, language: match.expected.language }),
        inputTokens: 150,
        outputTokens: 15,
      };
    }
    if (request.job === "reply-draft") {
      const language = /Write in this language: ([a-z]{2})/.exec(request.system)?.[1] ?? "en";
      return { text: CANNED_DRAFTS[language] ?? CANNED_DRAFTS.en!, inputTokens: 700, outputTokens: 90 };
    }
    if (request.job === "chaser-check") {
      const match = phase2.sentMessages.find((s) => request.user.includes(s.subject));
      if (!match) throw new Error("No recorded follow-up check for this message");
      return { text: JSON.stringify({ expects_reply: match.expectsReply ? "yes" : "no" }), inputTokens: 120, outputTokens: 8 };
    }
    if (request.job === "chaser-draft") {
      return { text: CANNED_CHASER, inputTokens: 500, outputTokens: 60 };
    }
    if (request.job === "file-type") {
      const match = phase2.attachments.find((a) => a.decidedBy === "model" && request.user.includes(a.name));
      if (!match) throw new Error("No recorded document type for this file");
      return { text: JSON.stringify({ type: match.expectedType }), inputTokens: 90, outputTokens: 6 };
    }
    return { text: "Greets with \"Dzień dobry,\". Short, direct sentences.", inputTokens: 900, outputTokens: 60 };
  }

  of(job: string): AiRequest[] {
    return this.requests.filter((r) => r.job === job);
  }
}

/** A stand-in for the customer's Microsoft 365 account: mailbox, Sent Items, Drafts folder and the OneDrive app folder. */
/** Stands in for Chromium: remembers each page it was asked to print and returns bytes that start like a PDF. */
export class FakePdf implements PdfRenderer {
  pages: string[] = [];
  async render(html: string) {
    this.pages.push(html);
    return new Uint8Array(Buffer.from(`%PDF-1.7 test document ${this.pages.length}\n${html}`, "utf8"));
  }
}

export class FakeOutlook implements OutlookGateway {
  drafts: { connectionId: string; providerMessageId: string; text: string; attachments: OutboundAttachment[] }[] = [];
  mailbox = new Map<string, InboundMessage>();
  pending: string[] = [];
  sentPending: string[] = [];
  /** Follow-up drafts written into the Drafts folder. */
  chaserDrafts: { id: string; sentMessageId: string; text: string; to: string[]; cc: string[] }[] = [];
  /** Drafts still sitting unsent. Remove an id to play "the customer deleted it" or "sent it". */
  waitingDrafts = new Set<string>();
  deletedDrafts: string[] = [];
  attachments = new Map<string, { info: AttachmentInfo; bytes: Uint8Array }[]>();
  /** The app folder in OneDrive: path -> content. */
  drive = new Map<string, Uint8Array>();
  driveDown = false;
  uploads = 0;

  async fetchMessage(_scope: CustomerScope, _connectionId: string, providerMessageId: string) {
    const message = this.mailbox.get(providerMessageId);
    if (!message) throw new Error("not in fake mailbox");
    return message;
  }
  async listNewMessageIds() {
    const messageIds = this.pending;
    this.pending = [];
    return { messageIds, deltaLink: `delta-${Date.now()}` };
  }
  async listNewSentMessageIds() {
    const messageIds = this.sentPending;
    this.sentPending = [];
    return { messageIds, deltaLink: `sent-delta-${Date.now()}` };
  }
  async createReplyDraft(
    _scope: CustomerScope,
    connectionId: string,
    providerMessageId: string,
    text: string,
    attachments: OutboundAttachment[] = [],
  ) {
    this.drafts.push({ connectionId, providerMessageId, text, attachments });
    return `draft-${this.drafts.length}`;
  }
  async createChaserDraft(
    _scope: CustomerScope,
    _connectionId: string,
    sentMessageId: string,
    text: string,
    to: string[],
    cc: string[],
  ) {
    const id = `chaser-draft-${this.chaserDrafts.length + 1}`;
    this.chaserDrafts.push({ id, sentMessageId, text, to, cc });
    this.waitingDrafts.add(id);
    return id;
  }
  async isDraftWaiting(_scope: CustomerScope, _connectionId: string, draftId: string) {
    return this.waitingDrafts.has(draftId);
  }
  async deleteDraft(_scope: CustomerScope, _connectionId: string, draftId: string) {
    this.waitingDrafts.delete(draftId);
    this.deletedDrafts.push(draftId);
  }
  async listAttachments(_scope: CustomerScope, _connectionId: string, providerMessageId: string) {
    return (this.attachments.get(providerMessageId) ?? []).map((a) => a.info);
  }
  async downloadAttachment(_scope: CustomerScope, _connectionId: string, providerMessageId: string, attachmentId: string) {
    const found = (this.attachments.get(providerMessageId) ?? []).find((a) => a.info.id === attachmentId);
    if (!found) throw new GraphError("Graph GET failed: 404 ErrorItemNotFound", 404);
    return found.bytes;
  }
  async uploadFile(_scope: CustomerScope, _connectionId: string, path: string, content: Uint8Array) {
    if (this.driveDown) throw new GraphError("Graph PUT failed: 503 serviceNotAvailable", 503);
    if (this.drive.has(path)) throw new GraphError("Graph PUT failed: 409 nameAlreadyExists", 409);
    this.drive.set(path, content);
    this.uploads++;
    return { itemId: `item-${this.drive.size}` };
  }
  async ensureSubscription() {}

  /** Puts a fixture mail with its attachments into the mailbox, as if it had just arrived. */
  deliver(mail: FixtureFilingMail): InboundMessage {
    const message = toFilingInbound(mail);
    this.mailbox.set(message.providerMessageId, message);
    this.attachments.set(
      message.providerMessageId,
      mail.attachments.map((id) => {
        const a = attachmentFixture(id);
        return {
          info: { id: `att-${mail.id}-${a.id}`, name: a.name, contentType: a.contentType, sizeBytes: a.sizeBytes, isInline: a.inline },
          bytes: attachmentBytes(a),
        };
      }),
    );
    return message;
  }
}

export class FakeMailer implements OutboundMailer {
  sent: OutboundEmail[] = [];
  async send(email: OutboundEmail) {
    this.sent.push(email);
  }
}

/** A queue that just remembers what was sent; `drain` then runs the reply-draft jobs in order. */
export class MemoryQueue implements JobQueue {
  jobs: { queue: QueueName; data: unknown }[] = [];
  async send<Q extends QueueName>(queue: Q, data: JobPayloads[Q]) {
    this.jobs.push({ queue, data });
  }
  of<Q extends QueueName>(queue: Q): JobPayloads[Q][] {
    return this.jobs.filter((j) => j.queue === queue).map((j) => j.data as JobPayloads[Q]);
  }
  async drain(deps: Deps) {
    const jobs = this.of(QUEUES.processMessage);
    this.jobs = this.jobs.filter((j) => j.queue !== QUEUES.processMessage);
    for (const job of jobs) await processMessage(deps, job);
  }
}

// ---- world -------------------------------------------------------------------

export function openTestDb(): Db {
  return createDb({
    connectionString: inject("databaseUrl"),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    max: 12,
  });
}

export function makeWorld(db: Db) {
  const ai = new RecordedAi();
  const outlook = new FakeOutlook();
  const mailer = new FakeMailer();
  const queue = new MemoryQueue();
  const pdf = new FakePdf();
  const deps: Deps = { db, queue, ai, mailer, outlook, pdf, appName: "Adminwise", appBaseUrl: "https://app.test" };
  return { ai, outlook, mailer, queue, pdf, deps };
}

/** Gives a test customer Nordpart's confirmed price list (120 items) and its offer details. */
export async function giveNordpartPriceList(scope: CustomerScope, settings: Partial<OfferSettings> = {}) {
  const unusedModel: AiClient = {
    async complete() {
      throw new Error("the Nordpart price list is read from its column titles, without the model");
    },
  };
  const { priceListId } = await importPriceList(scope, unusedModel, {
    fileName: "Cennik 2026.xlsx",
    bytes: new Uint8Array(readFileSync(path.join(fixturesDir, "price-list.xlsx"))),
    currency: "PLN",
  });
  await scope.activatePriceList(priceListId);
  await scope.updateOfferSettings({
    offerLanguage: "pl",
    offerLayout: "classic",
    currency: "PLN",
    vatRate: 23,
    paymentTerms: "14 dni od daty faktury",
    offerValidDays: 14,
    offerNumberPattern: "OF/{YYYY}/{NNN}",
    companyDetails: "Nordpart sp. z o.o.\nul. Przykładowa 1\n40-001 Katowice\nNIP 0000000000",
    bankDetails: "PL00 0000 0000 0000 0000 0000 0000",
    offerFooter: "Dziękujemy za zapytanie.",
    brandColor: "#1f6f6b",
    ...settings,
  });
  return priceListId;
}

/** What a mailbox connected before phase 2 was granted: no OneDrive. */
export const PHASE1_SCOPES = "Mail.Read Mail.ReadWrite User.Read profile openid email";

/** A fresh copy of the Nordpart customer, so tests never see each other's data. */
export async function createNordpart(
  db: Db,
  options: {
    languages?: string[];
    timeZone?: string;
    briefStartDate?: string;
    /** What Microsoft granted. Default: everything, including the OneDrive app folder. */
    scopes?: string;
  } = {},
) {
  const tag = randomBytes(4).toString("hex");
  const email = `tomasz.${tag}@${company.domain}`;
  const { customerId, userId } = await system(db).createCustomerWithUser({
    email,
    slug: `${company.slug}-${tag}`,
    timeZone: options.timeZone ?? company.timeZone,
    briefStartDate: options.briefStartDate,
  });
  const scope = forCustomer(db, customerId);
  await scope.updateSettings({
    name: company.name,
    languages: options.languages ?? company.languages,
    timeZone: options.timeZone ?? company.timeZone,
    signatureText: company.signatureText,
  });
  await scope.setVoiceProfile(company.voiceProfile);
  const microsoft = await scope.upsertConnection({
    provider: "microsoft",
    emailAddress: company.mailbox,
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    scopes: options.scopes ?? `${PHASE1_SCOPES} Files.ReadWrite.AppFolder`,
  });
  const forwarding = (await scope.getConnectionByProvider("forwarding"))!;
  return { customerId, userId, email, scope, microsoftId: microsoft.id, forwardingId: forwarding.id };
}

/** Stores the 8 earlier messages of the long thread (scenario 4). */
export async function seedLongThread(scope: CustomerScope, connectionId: string) {
  for (const m of longThread.messages) {
    await scope.insertMessage({
      threadKey: longThread.threadKey,
      connectionId,
      dedupeKey: m.messageId,
      providerMessageId: `graph-${m.messageId}`,
      direction: m.direction,
      senderDomain: domainOf(m.from),
      fromAddress: m.from,
      subject: longThread.subject,
      receivedAt: new Date(m.receivedAt),
      headerFlags: {},
      attachmentNames: [],
      bodyText: m.bodyText,
    });
  }
}
