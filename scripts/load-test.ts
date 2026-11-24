/* eslint-disable no-restricted-syntax -- a measuring script on a throw-away database: it reads the job log across all its test customers */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { createBedrockClient, withPatience, WORKER_PATIENCE, type AiClient } from "../packages/ai/src";
import { loadConfig } from "../packages/core/src/config";
import { ingestInbound } from "../packages/core/src/ingest";
import type { OutlookGateway } from "../packages/core/src/outlook";
import { startQueue } from "../packages/core/src/queue";
import { createDb, forCustomer, migrate, system } from "../packages/db/src";
import { importPriceList } from "../packages/offers/src";
import type { Deps } from "../apps/worker/src/deps";
import { createPdfRenderer } from "../apps/worker/src/pdf";
import { registerWorkers } from "../apps/worker/src/register";

/**
 * `pnpm load:test [customers] [mails per customer]` (default 10 and 10).
 *
 * A burst of mail for several customers at once, through the REAL queue, the
 * REAL model and the REAL PDF printer, with the worker handling five mails at a
 * time as in production. Only the mailbox is a stand-in. It answers:
 *   - how many mails a minute are handled, and how long one mail takes,
 *   - how often AWS refuses a request for being too many at once, and whether
 *     every mail still gets handled in the end,
 *   - what one mail costs in model use.
 * Uses a throw-away local database and the invented test companies. Needs the
 * AWS keys in .env; the default run costs about two euros.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}

const CUSTOMERS = Number(process.argv[2] ?? 10);
const MAILS_EACH = Number(process.argv[3] ?? 10);
const CONCURRENCY = 5; // the worker's setting in production
const TIMEOUT_MS = 20 * 60_000;
/** USD per million tokens (input, output), list prices as known in mid-2026; the EU profiles may cost a little more. */
const PRICES: Record<string, [number, number]> = { sonnet: [3, 15], haiku: [1, 5] };

/** A realistic mix per company: quote requests, ordinary questions, a notice only the model can spot, a hostile mail. */
const MIX: Record<string, string[]> = {
  lipka: ["L003", "L010", "L016", "L024", "L041", "L007", "L014", "L046", "L008", "L027"],
  veld: ["V002", "V005", "V009", "V012", "V026", "V003", "V021", "V054", "V016", "V019"],
};
const root = path.resolve(import.meta.dirname, "../fixtures");
const readJson = async <T>(slug: string, name: string) => JSON.parse(await readFile(path.join(root, slug, name), "utf8")) as T;

interface Mail { id: string; at: string; from: { address: string; name: string }; subject: string; body: string; expected: { outcome: string } }

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

// ---- a throw-away database --------------------------------------------------
const dir = await mkdtemp(path.join(tmpdir(), "adminwise-load-pg-"));
const port = await freePort();
const postgres = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
await postgres.initialise();
await postgres.start();
await postgres.createDatabase("adminwise_load");
const url = `postgres://postgres:postgres@127.0.0.1:${port}/adminwise_load`;
await migrate(url);
const db = createDb({ connectionString: url, encryptionKey: Buffer.alloc(32, 9).toString("base64"), max: 12 });

// ---- the real model, counted ------------------------------------------------
const config = loadConfig({ ...process.env, DATABASE_URL: url, TOKEN_ENCRYPTION_KEY: "unused" } as NodeJS.ProcessEnv);
const real = createBedrockClient(config.aws);
const usage: Record<string, { calls: number; input: number; output: number; ms: number }> = {};
let refused = 0;
let otherErrors = 0;
// As in the worker: a refused request waits and is tried again. Set LOAD_TEST_IMPATIENT=1 to see the old behaviour.
const counted: AiClient = {
  async complete(request) {
    const started = Date.now();
    try {
      const result = await real.complete(request);
      const u = (usage[request.job] ??= { calls: 0, input: 0, output: 0, ms: 0 });
      u.calls++;
      u.input += result.inputTokens;
      u.output += result.outputTokens;
      u.ms += Date.now() - started;
      return result;
    } catch (error) {
      if (error instanceof Error && /429|too many requests|throttl/i.test(error.message)) refused++;
      else otherErrors++;
      throw error;
    }
  },
};
const ai: AiClient = process.env.LOAD_TEST_IMPATIENT ? counted : withPatience(counted, WORKER_PATIENCE);

// ---- the mailbox stand-in ---------------------------------------------------
let drafts = 0;
let uploads = 0;
const notUsed = async (): Promise<never> => {
  throw new Error("not used in the load test");
};
const outlook = {
  createReplyDraft: async () => `draft-${++drafts}`,
  uploadFile: async () => ({ itemId: `item-${++uploads}` }),
  fetchMessage: notUsed, listNewMessageIds: notUsed, listNewSentMessageIds: notUsed, createChaserDraft: notUsed,
  isDraftWaiting: async () => false, deleteDraft: async () => {}, listAttachments: async () => [], downloadAttachment: notUsed, ensureSubscription: async () => {},
} as unknown as OutlookGateway;

const realPdf = createPdfRenderer();
let pdfs = 0;
let pdfMs = 0;
const pdf = {
  async render(html: string) {
    const started = Date.now();
    const bytes = await realPdf.render(html);
    pdfs++;
    pdfMs += Date.now() - started;
    return bytes;
  },
};

// ---- customers ----------------------------------------------------------------
const slugs = Object.keys(MIX);
const customers: { id: string; slug: string; connectionId: string; mails: Mail[] }[] = [];
for (let n = 0; n < CUSTOMERS; n++) {
  const slug = slugs[n % slugs.length]!;
  const c = await readJson<{ name: string; slug: string; ownerEmail: string; mailbox: string; languages: string[]; timeZone: string; signatureText: string; voiceProfile: string; followUpDays: number; replyDrafts?: "all" | "sales" | "off"; offer: Parameters<ReturnType<typeof forCustomer>["updateOfferSettings"]>[0]; discounts: { match: string; percent: number }[]; priceList: { file: string; fileName: string } }>(slug, "company.json");
  const tag = randomBytes(3).toString("hex");
  const { customerId } = await system(db).createCustomerWithUser({ email: c.ownerEmail.replace("@", `.${tag}@`), slug: `${c.slug}-${tag}`, timeZone: c.timeZone });
  const scope = forCustomer(db, customerId);
  await scope.updateSettings({ name: c.name, languages: c.languages, timeZone: c.timeZone, signatureText: c.signatureText, followUpDays: c.followUpDays, replyDrafts: c.replyDrafts ?? "all" });
  await scope.setVoiceProfile(c.voiceProfile);
  const connection = await scope.upsertConnection({ provider: "microsoft", emailAddress: c.mailbox, accessToken: "x", refreshToken: "x", tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: "Mail.Read Mail.ReadWrite Files.ReadWrite.AppFolder" });
  const list = await importPriceList(scope, ai, { fileName: c.priceList.fileName, bytes: new Uint8Array(await readFile(path.join(root, slug, c.priceList.file))), currency: c.offer.currency });
  await scope.activatePriceList(list.priceListId);
  await scope.updateOfferSettings(c.offer);
  for (const d of c.discounts) await scope.setDiscount(d.match, d.percent);
  const all = (await readJson<{ mail: Mail[] }>(slug, "mail.json")).mail;
  const mails = Array.from({ length: MAILS_EACH }, (_, i) => all.find((m) => m.id === MIX[slug]![i % MIX[slug]!.length])!);
  customers.push({ id: customerId, slug, connectionId: connection.id, mails });
}

// ---- the burst ------------------------------------------------------------------
const queue = await startQueue(url, "worker");
const deps: Deps = { db, queue, ai, mailer: { send: async () => {} }, outlook, pdf, appName: "Adminwise", appBaseUrl: "https://app.test" };
await registerWorkers(queue.boss, deps, CONCURRENCY);

const total = CUSTOMERS * MAILS_EACH;
console.log(`${total} mails for ${CUSTOMERS} customers, worker handling ${CONCURRENCY} at a time. Models: ${config.aws.models.default} and ${config.aws.models.classify}.`);
let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 500);
const started = Date.now();
await Promise.all(
  customers.flatMap((customer) =>
    customer.mails.map((mail, i) =>
      ingestInbound(forCustomer(db, customer.id), queue, customer.connectionId, {
        providerMessageId: `load-${customer.id}-${i}`,
        internetMessageId: `<load-${customer.id}-${i}@load.example>`,
        threadKey: `load-${customer.id}-${i}`,
        subject: mail.subject,
        from: mail.from,
        receivedAt: new Date(),
        bodyText: mail.body,
        headerFlags: {},
        attachmentNames: [],
      }),
    ),
  ),
);
const ingested = Date.now() - started;

// Done = every mail has a finished run that did not fail (a failed run is tried again by the queue).
const settled = async () => {
  const { rows } = await db.pool.query(
    "SELECT count(DISTINCT ref)::int AS done FROM job_runs WHERE job = 'reply-draft' AND status IN ('succeeded', 'skipped')",
  );
  return rows[0].done as number;
};
let done: number;
let lastPrinted = 0;
while ((done = await settled()) < total && Date.now() - started < TIMEOUT_MS) {
  if (Date.now() - lastPrinted > 30_000) {
    console.log(`  ${Math.round((Date.now() - started) / 1000)} s: ${done} of ${total} handled, ${refused} requests refused by AWS so far`);
    lastPrinted = Date.now();
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const elapsed = Date.now() - started;
clearInterval(sampler);

// ---- the report -----------------------------------------------------------------
const runs = (await db.pool.query("SELECT ref, status, outcome, error, extract(epoch FROM finished_at - started_at) AS seconds, started_at, finished_at FROM job_runs WHERE job = 'reply-draft' ORDER BY started_at")).rows as { ref: string; status: string; outcome: string | null; error: string | null; seconds: number; started_at: Date; finished_at: Date | null }[];
const good = runs.filter((r) => r.status === "succeeded");
const failedRuns = runs.filter((r) => r.status === "failed");
const seconds = good.map((r) => Number(r.seconds)).sort((a, b) => a - b);
const at = (p: number) => seconds[Math.min(seconds.length - 1, Math.floor(seconds.length * p))]?.toFixed(1) ?? "-";
const waits = good.map((r) => (r.finished_at!.getTime() - started) / 1000).sort((a, b) => a - b);

const outcomes: Record<string, number> = {};
for (const r of good) outcomes[r.outcome ?? "?"] = (outcomes[r.outcome ?? "?"] ?? 0) + 1;
let wrong = 0;
for (const customer of customers) {
  for (const [i, mail] of customer.mails.entries()) {
    const message = (await db.pool.query("SELECT id FROM messages WHERE customer_id = $1 AND provider_message_id = $2", [customer.id, `load-${customer.id}-${i}`])).rows[0];
    const run = good.find((r) => r.ref === message?.id);
    const got = run?.outcome?.startsWith("no_draft:") ? `none:${run.outcome.slice(9)}` : (run?.outcome?.split(":")[0] ?? "not handled");
    // A hostile notice may be sorted as business or as a notification: either way it gets no draft.
    const same = got === mail.expected.outcome || (got.startsWith("none:") && mail.expected.outcome === "none:suspicious") || (got === "none:suspicious" && mail.expected.outcome.startsWith("none:"));
    if (!same) {
      wrong++;
      console.log(`  DIFF  ${customer.slug} ${mail.id}: ${got}; expected ${mail.expected.outcome}`);
    }
  }
}

let cost = 0;
console.log("\nRESULT");
console.log(`  Handled:            ${done} of ${total} mails in ${(elapsed / 1000).toFixed(0)} s (taking them in took ${(ingested / 1000).toFixed(1)} s)`);
console.log(`  Speed:              ${((done / elapsed) * 60_000).toFixed(1)} mails a minute`);
console.log(`  One mail, working:  half within ${at(0.5)} s, nine in ten within ${at(0.9)} s, slowest ${at(1)} s`);
console.log(`  Waiting in line:    half done after ${waits[Math.floor(waits.length * 0.5)]?.toFixed(0) ?? "-"} s, the last after ${waits.at(-1)?.toFixed(0) ?? "-"} s`);
console.log(`  Refused by AWS:     ${refused} requests ("too many at once"); other model errors: ${otherErrors}`);
console.log(`  Runs that failed and were tried again: ${failedRuns.length}${failedRuns.length ? ` (${[...new Set(failedRuns.map((r) => (r.error ?? "").split(":")[0]))].join(", ")})` : ""}`);
console.log(`  Outcomes:           ${Object.entries(outcomes).map(([k, v]) => `${v} x ${k}`).join(", ")}`);
console.log(`  Different from the fixtures: ${wrong}`);
console.log(`  Drafts written: ${drafts}; offers printed as PDF: ${pdfs}${pdfs ? `, ${(pdfMs / pdfs / 1000).toFixed(1)} s each` : ""}; peak memory of this process: ${(peakRss / 1024 / 1024).toFixed(0)} MB (without the PDF browser's own processes)`);
console.log("  Model use:");
for (const [job, u] of Object.entries(usage).sort()) {
  const kind = (config.aws.models[job] ?? config.aws.models.default).includes("haiku") ? "haiku" : "sonnet";
  const usd = (u.input * PRICES[kind]![0] + u.output * PRICES[kind]![1]) / 1_000_000;
  cost += usd;
  console.log(`    ${job.padEnd(18)} ${String(u.calls).padStart(4)} calls, ${(u.ms / u.calls / 1000).toFixed(1)} s each, ${u.input} tokens in, ${u.output} out, about $${usd.toFixed(3)} (${kind})`);
}
console.log(`  Cost of this run:   about $${cost.toFixed(2)}, or $${(cost / total).toFixed(4)} a mail (list prices; the EU profiles may cost about a tenth more)`);

await queue.stop();
await realPdf.close();
await db.close();
await postgres.stop();
await rm(dir, { recursive: true, force: true }).catch(() => {});
process.exit(done === total && wrong === 0 ? 0 : 1);
