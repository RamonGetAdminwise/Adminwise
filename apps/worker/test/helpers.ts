import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AiClient, AiRequest, AiResult } from "@adminwise/ai";
import { QUEUES, type JobPayloads, type JobQueue, type OutlookGateway, type QueueName } from "@adminwise/core";
import { createDb, forCustomer, system, type CustomerScope, type Db } from "@adminwise/db";
import { domainOf, flagsFromHeaders, type InboundMessage, type OutboundEmail, type OutboundMailer } from "@adminwise/mail";
import { inject } from "vitest";
import type { Deps } from "../src/deps";
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
  expected: { category: string; language: string | null; decidedBy: "rule" | "model" };
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
export const sentEmails = readJson<{ id: string; language: string; bodyText: string }[]>("sent-emails.json");
export const longThread = readJson<{
  threadKey: string;
  subject: string;
  messages: { messageId: string; direction: "inbound" | "outbound"; from: string; receivedAt: string; bodyText: string }[];
}>("thread-long.json");

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

/**
 * Stands in for the model. Classification answers are the ones recorded in the
 * fixtures ("expected"); drafts are a fixed text per language. It records every
 * request, so tests can check exactly what the model was asked.
 */
export class RecordedAi implements AiClient {
  requests: AiRequest[] = [];

  async complete(request: AiRequest): Promise<AiResult> {
    this.requests.push(request);
    if (request.job === "classify") {
      const match = inbound.find((f) => request.user.includes(f.subject));
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
    return { text: "Greets with \"Dzień dobry,\". Short, direct sentences.", inputTokens: 900, outputTokens: 60 };
  }

  of(job: string): AiRequest[] {
    return this.requests.filter((r) => r.job === job);
  }
}

export class FakeOutlook implements OutlookGateway {
  drafts: { connectionId: string; providerMessageId: string; text: string }[] = [];
  mailbox = new Map<string, InboundMessage>();
  pending: string[] = [];

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
  async createReplyDraft(_scope: CustomerScope, connectionId: string, providerMessageId: string, text: string) {
    this.drafts.push({ connectionId, providerMessageId, text });
    return `draft-${this.drafts.length}`;
  }
  async ensureSubscription() {}
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
  const deps: Deps = { db, queue, ai, mailer, outlook, appName: "Adminwise", appBaseUrl: "https://app.test" };
  return { ai, outlook, mailer, queue, deps };
}

/** A fresh copy of the Nordpart customer, so tests never see each other's data. */
export async function createNordpart(
  db: Db,
  options: { languages?: string[]; timeZone?: string; briefStartDate?: string } = {},
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
