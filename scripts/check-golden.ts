import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  checkExpectsReply,
  checkOfferAccepted,
  checkPaymentNotice,
  classifyDocument,
  classifyMessage,
  createBedrockClient,
  detectQuoteRequest,
  matchItems,
  readInvoiceFields,
} from "../packages/ai/src";
import { loadConfig } from "../packages/core/src/config";
import { checkInvoice, extractPdfText, matchByCode, rankCandidates, unitMeansOne } from "../packages/offers/src";
import { SYSTEM_SENDER } from "../apps/worker/src/jobs/prefilter";

/**
 * `pnpm check:golden [lipka|veld]`: the golden set. Runs every decision the
 * model makes for the invented test companies (fixtures/lipka, fixtures/veld)
 * through the REAL model and compares it with what the fixtures expect:
 *   - sorting each mail (category, language, hostile or not),
 *   - quote requests: is it one, what is asked, which price list items,
 *   - is this reply an acceptance; does it say an invoice was paid,
 *   - does a sent mail expect an answer,
 *   - what kind of document an attachment is,
 *   - reading the invoices.
 * What the model answered is saved in golden/<company>.json, so that after a
 * change to a prompt the next run shows exactly which answers moved.
 * Needs the AWS keys in .env; a full run costs well under one euro. Invented data only.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}

const CANDIDATES_PER_ITEM = 10; // as in apps/worker/src/jobs/quote.ts
// Two at a time, and patient: the AWS account allows only a few requests per second.
const PARALLEL = 2;
const root = path.resolve(import.meta.dirname, "..");
const real = createBedrockClient(loadConfig().aws);
const ai: typeof real = {
  async complete(request) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await real.complete(request);
      } catch (error) {
        const throttled = error instanceof Error && /429|too many requests|throttl/i.test(error.message);
        if (!throttled || attempt >= 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      }
    }
  },
};

interface Mail {
  id: string; from: { address: string }; subject: string; thread?: string; body: string; attachments?: string[];
  expected: {
    category: string; language: string | null; decidedBy: string; suspicious?: boolean; outcome: string;
    quote?: { isQuote: boolean }; offerLines?: { code: string; quantity: number }[]; accepts?: boolean; paid?: boolean;
  };
}
interface Sent { id: string; to: string[]; subject: string; thread?: string; invoice?: string; body: string; expectsReply: boolean }
interface Attachment { id: string; name: string; expected: { type: string | null; decidedBy: string } }
interface Invoice { id: string; file: string; expected: { status: string; number?: string; amountCents?: number; dueDate?: string | null; buyer?: string }; recorded: unknown }

async function inParallel<T>(items: T[], work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await work(item);
  }));
}

async function runCompany(slug: string): Promise<number> {
  const dir = path.join(root, "fixtures", slug);
  const read = <T>(name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;
  const company = read<{ name: string; domain: string; offer: { companyDetails: string; currency: string } }>("company.json");
  const mail = read<{ mail: Mail[] }>("mail.json").mail;
  const sent = read<{ sent: Sent[] }>("sent.json").sent;
  const attachments = read<{ attachments: Attachment[] }>("attachments.json").attachments;
  const invoices = read<{ invoices: Invoice[] }>("invoices.json").invoices;
  const seen = new Set<string>();
  const items = read<{ rows: (string | number)[][] }>("price-list.json").rows
    .filter(([code, , , price]) => typeof price === "number" && !seen.has(String(code)) && seen.add(String(code)))
    .map(([code, name, unit, , aliases]) => ({ id: String(code), code: String(code), name: String(name), unit: String(unit), aliases: String(aliases ?? "").split(";").map((a) => a.trim()).filter(Boolean) }));

  const golden: Record<string, unknown> = {};
  const differences: string[] = [];
  const counts: Record<string, [ok: number, total: number]> = {};
  const check = (step: string, id: string, ok: boolean, got: string, expected: string) => {
    const c = (counts[step] ??= [0, 0]);
    c[1]++;
    if (ok) c[0]++;
    else differences.push(`${step.padEnd(12)} ${id.padEnd(6)} got ${got}; expected ${expected}`);
  };
  const guard = async (step: string, id: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      check(step, id, false, error instanceof Error ? `${error.name}: ${error.message.slice(0, 120)}` : "error", "an answer");
    }
  };

  await inParallel(mail.filter((m) => m.expected.decidedBy === "model"), async (m) => {
    const e = m.expected;
    const record: Record<string, unknown> = {};
    golden[m.id] = record;
    await guard("sorting", m.id, async () => {
      const answer = await classifyMessage(ai, { companyName: company.name, subject: m.subject, senderDomain: m.from.address.split("@")[1] ?? "", body: m.body });
      // As in the product: the model's "a colleague" about an outside sender is treated as business mail.
      const got = { ...answer, category: answer.category === "internal" ? "business" : answer.category };
      record.modelSaidInternal = answer.category === "internal" ? true : undefined;
      record.sorting = { category: got.category, language: got.language, suspicious: got.suspicious };
      // A hostile mail that poses as a notice is sorted as business on one run and as a notification on
      // the next. Both mean: no draft, and listed in the brief. What must hold is that it is flagged.
      const sameForHostile = e.suspicious && ["business", "notification"].includes(got.category) && ["business", "notification"].includes(e.category);
      check("sorting", m.id, got.category === e.category || Boolean(sameForHostile), got.category, e.category);
      if (got.category === e.category) check("language", m.id, got.language === e.language, got.language, String(e.language));
      check("hostile", m.id, got.suspicious === (e.suspicious ?? false), got.suspicious ? "flagged" : "not flagged", e.suspicious ? "flagged" : "not flagged");
    });
    if (e.category !== "business" || e.suspicious) return;

    if (e.accepts !== undefined) {
      await guard("acceptance", m.id, async () => {
        const got = await checkOfferAccepted(ai, { companyName: company.name, offerNumber: "the open offer", subject: m.subject, body: m.body });
        record.accepts = got.accepted;
        check("acceptance", m.id, got.accepted === e.accepts, got.accepted ? "accepts" : "does not accept", e.accepts ? "accepts" : "does not accept");
      });
    }
    if (e.paid !== undefined) {
      await guard("paid", m.id, async () => {
        const invoiceMail = sent.find((s) => s.invoice && (s.thread ?? `thr-${s.id}`) === m.thread);
        const number = invoices.find((i) => i.id === invoiceMail?.invoice)?.expected.number ?? "";
        const got = await checkPaymentNotice(ai, { companyName: company.name, invoiceNumbers: [number], subject: m.subject, body: m.body });
        record.paid = got.paid;
        check("paid", m.id, got.paid === e.paid, got.paid ? "paid" : "not paid", e.paid ? "paid" : "not paid");
      });
    }
    if (e.accepts === true) return; // an accepted offer becomes an order confirmation; the quote step is not asked

    await guard("quote", m.id, async () => {
      const got = await detectQuoteRequest(ai, { companyName: company.name, subject: m.subject, body: m.body });
      const expectedQuote = e.quote?.isQuote ?? false;
      check("quote", m.id, got.isQuoteRequest === expectedQuote, got.isQuoteRequest ? "a quote request" : "not a quote request", expectedQuote ? "a quote request" : "not a quote request");
      record.quote = { isQuote: got.isQuoteRequest, items: got.items };
      if (!got.isQuoteRequest || !expectedQuote) return;

      // The same steps as the product: by code, then the model from a short list, then the quantity rule.
      const found = new Map<number, (typeof items)[number]>();
      const forModel: { index: number; candidates: typeof items }[] = [];
      got.items.forEach((requested, index) => {
        const byCode = matchByCode(requested.request, items);
        if (byCode && byCode !== "ambiguous") found.set(index, byCode);
        else if (!byCode) {
          const candidates = rankCandidates(requested.request, items, CANDIDATES_PER_ITEM);
          if (candidates.length > 0) forModel.push({ index, candidates });
        }
      });
      if (forModel.length > 0) {
        const answer = await matchItems(ai, { items: forModel.map((f) => ({ request: got.items[f.index]!.request, candidates: f.candidates.map((c) => ({ code: c.code, name: c.name, aliases: c.aliases, unit: c.unit })) })) });
        answer.matches.forEach((match, i) => {
          if (match.result === "match") found.set(forModel[i]!.index, forModel[i]!.candidates[match.candidate - 1]!);
        });
        record.matching = answer.matches.map((match, i) => `${got.items[forModel[i]!.index]!.request}: ${match.result === "match" ? forModel[i]!.candidates[match.candidate - 1]!.code : match.result}`);
      }
      const lines: { code: string; quantity: number }[] = [];
      got.items.forEach((requested, index) => {
        const item = found.get(index);
        if (!item) return;
        if (requested.quantity !== null) lines.push({ code: item.code, quantity: requested.quantity });
        else if (unitMeansOne(item.unit)) lines.push({ code: item.code, quantity: 1 });
      });
      record.offerLines = lines;
      const show = (l: { code: string; quantity: number }[]) => (l.length ? l.map((x) => `${x.quantity} x ${x.code}`).join(", ") : "no offer lines");
      check("offer lines", m.id, show(lines) === show(e.offerLines ?? []), show(lines), show(e.offerLines ?? []));
    });
  });

  await inParallel(sent.filter((s) => !s.invoice && !s.to.every((to) => to.endsWith(`@${company.domain}`) || SYSTEM_SENDER.test(to))), async (s) => {
    await guard("expects reply", s.id, async () => {
      const got = await checkExpectsReply(ai, { companyName: company.name, subject: s.subject, body: s.body });
      golden[s.id] = { expectsReply: got.expectsReply };
      check("expects reply", s.id, got.expectsReply === s.expectsReply, got.expectsReply ? "expects a reply" : "expects none", s.expectsReply ? "expects a reply" : "expects none");
    });
  });

  await inParallel(attachments.filter((a) => a.expected.decidedBy === "model"), async (a) => {
    await guard("file type", a.id, async () => {
      const owner = mail.find((m) => m.attachments?.includes(a.id))!;
      const got = await classifyDocument(ai, { fileName: a.name, subject: owner.subject, body: owner.body });
      golden[a.id] = { type: got.type };
      check("file type", a.id, got.type === a.expected.type, got.type, String(a.expected.type));
    });
  });

  await inParallel(invoices, async (invoice) => {
    await guard("invoice", invoice.id, async () => {
      const text = await extractPdfText(new Uint8Array(readFileSync(path.join(dir, "invoices", invoice.file))));
      const e = invoice.expected;
      if (!text) {
        golden[invoice.id] = { status: "unreadable" };
        check("invoice", invoice.id, e.status === "unreadable", "unreadable (no text in the PDF)", e.status);
        return;
      }
      const { reading } = await readInvoiceFields(ai, { companyName: company.name, companyDetails: company.offer.companyDetails, text });
      let status = "not_ours";
      let fields = "";
      if (reading.isInvoice && reading.issuedByCompany) {
        const checked = checkInvoice(text, reading, company.offer.currency);
        status = !checked.number || checked.amountCents === null ? "unreadable" : checked.dueDate ? "open" : "needs_due_date";
        fields = `${checked.number}, ${checked.amountCents}, due ${checked.dueDate}, buyer "${checked.buyer}"`;
        if (e.number) check("invoice", invoice.id, fields === `${e.number}, ${e.amountCents}, due ${e.dueDate ?? null}, buyer "${e.buyer}"`, fields, `${e.number}, ${e.amountCents}, due ${e.dueDate ?? null}, buyer "${e.buyer}"`);
      }
      golden[invoice.id] = { status, fields, language: reading.language };
      check("invoice", invoice.id, status === e.status, status, e.status);
    });
  });

  // What the model answered, sorted so that two runs can be compared line by line.
  mkdirSync(path.join(root, "golden"), { recursive: true });
  const file = path.join(root, "golden", `${slug}.json`);
  let before = "";
  try {
    before = readFileSync(file, "utf8");
  } catch {
    // first run
  }
  const now = `${JSON.stringify(Object.fromEntries(Object.entries(golden).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`;
  writeFileSync(file, now);

  console.log(`\n${company.name}`);
  for (const [step, [ok, total]] of Object.entries(counts)) console.log(`  ${step.padEnd(14)} ${ok} of ${total} as expected`);
  for (const line of differences.sort()) console.log(`  DIFF  ${line}`);
  console.log(before === "" ? "  (first run: answers saved)" : before === now ? "  Same answers as the previous run." : "  Answers changed since the previous run: compare golden/" + slug + ".json in git.");
  return differences.length;
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
let total = 0;
for (const slug of wanted.length ? wanted : ["lipka", "veld"]) total += await runCompany(slug);
console.log(total === 0 ? "\nAll as expected." : `\n${total} difference(s): read the lines marked DIFF.`);
process.exit(total === 0 ? 0 : 1);
