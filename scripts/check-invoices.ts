import { readFileSync } from "node:fs";
import path from "node:path";
import { checkPaymentNotice, createBedrockClient, draftPaymentReminder, readInvoiceFields } from "../packages/ai/src";
import { loadConfig } from "../packages/core/src/config";
import { checkInvoice, extractPdfText } from "../packages/offers/src";

/**
 * `pnpm check:invoices`: runs the Nordpart invoice PDFs and payment replies
 * through the REAL model and compares with what the fixtures expect, then
 * prints one reminder per level so a person can judge the tone.
 * Needs the AWS keys in .env and costs a few cents. Invented fixture data only.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}

const dir = path.resolve(import.meta.dirname, "../fixtures/nordpart");
const invoices = (JSON.parse(readFileSync(path.join(dir, "invoices/invoices.json"), "utf8")) as {
  invoices: { id: string; file: string; expected: { status: string; number?: string; amountCents?: number; dueDate?: string | null; buyer?: string } }[];
}).invoices;
const payments = JSON.parse(readFileSync(path.join(dir, "payments.json"), "utf8")) as { id: string; subject: string; bodyText: string; expected: { paid: boolean } }[];
const COMPANY = { companyName: "Nordpart sp. z o.o.", companyDetails: "Nordpart sp. z o.o.\nul. Przykładowa 1, 40-001 Katowice\nNIP 0000000000" };

const ai = createBedrockClient(loadConfig().aws);
let differences = 0;
const report = (ok: boolean, id: string, what: string) => {
  if (!ok) differences++;
  console.log(`${ok ? "ok  " : "DIFF"}  ${id}  ${what}`);
};

for (const f of invoices) {
  try {
    const text = await extractPdfText(new Uint8Array(readFileSync(path.join(dir, "invoices", f.file))));
    if (!text) {
      report(f.expected.status === "unreadable", f.id, "no text in the PDF: unreadable, the model is not asked");
      continue;
    }
    const { reading } = await readInvoiceFields(ai, { ...COMPANY, text });
    let status: string;
    if (!reading.isInvoice || !reading.issuedByCompany) status = "not_ours";
    else {
      const checked = checkInvoice(text, reading, "PLN");
      status = !checked.number || checked.amountCents === null ? "unreadable" : checked.dueDate ? "open" : "needs_due_date";
      if (status === "open" || status === "needs_due_date") {
        const same = checked.number === f.expected.number && checked.amountCents === f.expected.amountCents && checked.dueDate === (f.expected.dueDate ?? null) && checked.buyer === f.expected.buyer;
        report(same, f.id, `fields: ${checked.number}, ${checked.amountCents}, due ${checked.dueDate}, buyer "${checked.buyer}", language ${reading.language}`);
      }
    }
    report(status === f.expected.status, f.id, `status: ${status} (expected ${f.expected.status})`);
  } catch (error) {
    report(false, f.id, error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "error");
  }
}

for (const p of payments) {
  const { paid } = await checkPaymentNotice(ai, { companyName: COMPANY.companyName, invoiceNumbers: ["FV/2026/11/0457"], subject: p.subject, body: p.bodyText });
  report(paid === p.expected.paid, p.id, `says it was paid: ${paid ? "yes" : "no"} (expected ${p.expected.paid ? "yes" : "no"})`);
}

console.log("\nSample reminders for a person to read (invoice FV/2026/11/0457, 26 372,43 PLN, due 2026-11-17):");
for (const [level, daysOverdue] of [[1, 7], [2, 14], [3, 30]] as const) {
  const { body } = await draftPaymentReminder(ai, {
    companyName: COMPANY.companyName,
    voiceProfile: "Greets with \"Dzień dobry,\". Short, direct, polite sentences. Closes with \"Pozdrawiam\".",
    language: "pl",
    level,
    invoiceNumber: "FV/2026/11/0457",
    amount: "26 372,43 PLN",
    dueDate: "2026-11-17",
    daysOverdue,
  });
  const facts = body.includes("FV/2026/11/0457") && /26\s?372,43/.test(body) && /2026-11-17|17\.11\.2026|17 listopada/.test(body);
  report(facts, `level ${level}`, facts ? "states the number, amount and due date" : "a fact is missing or changed");
  console.log(`--- reminder ${level}\n${body}\n`);
}
console.log(differences === 0 ? "RESULT: OK, the real model agrees with every fixture" : `RESULT: ${differences} difference(s) to look at`);
process.exit(differences === 0 ? 0 : 1);
