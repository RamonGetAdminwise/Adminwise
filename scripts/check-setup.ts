import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyMessage, createBedrockClient, draftReply, readOfferDetails } from "../packages/ai/src";
import { loadConfig } from "../packages/core/src/config";
import { setupTestMail } from "../packages/core/src/setup";
import { checkOfferDetails, extractPdfText } from "../packages/offers/src";
import { SYSTEM_SENDER } from "../apps/worker/src/jobs/prefilter";

/**
 * `pnpm check:setup`: runs the two things the "Getting started" guide depends
 * on through the REAL model.
 *   1. The guide's test mail must be seen as business mail (in English and in
 *      Polish) and get a draft, or the guided test would never succeed.
 *   2. Company details are read from Nordpart's invented invoice PDF; only the
 *      seller's details may come back.
 * Needs the AWS keys in .env and costs a few cents. Invented fixture data only.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}

const config = loadConfig();
const ai = createBedrockClient(config.aws);
let differences = 0;
const report = (ok: boolean, id: string, what: string) => {
  if (!ok) differences++;
  console.log(`${ok ? "ok  " : "DIFF"}  ${id}  ${what}`);
};

const fromAddress = /<([^>]+)>/.exec(config.mailFrom)?.[1] ?? config.mailFrom;
report(!SYSTEM_SENDER.test(fromAddress), "sender", "our sending address is not treated as an automatic sender by the rules");

for (const language of ["en", "pl"]) {
  const mail = setupTestMail([language], config.appName);
  const senderDomain = fromAddress.split("@")[1] ?? "";
  const { category, language: found } = await classifyMessage(ai, { companyName: "Nordpart sp. z o.o.", subject: mail.subject, senderDomain, body: mail.textBody });
  report(category === "business" && found === language, `mail-${language}`, `classified as ${category}, language ${found} (expected business, ${language})`);
  const { body } = await draftReply(ai, {
    companyName: "Nordpart sp. z o.o.",
    voiceProfile: "",
    language,
    latest: { senderDomain, subject: mail.subject, body: mail.textBody },
    history: [],
  });
  report(body.length > 40, `draft-${language}`, "draft written:");
  console.log(body.split("\n").map((line) => `        ${line}`).join("\n"));
}

const pdf = new Uint8Array(readFileSync(path.resolve(import.meta.dirname, "../fixtures/nordpart/invoices/FV_2026_11_0457.pdf")));
const text = (await extractPdfText(pdf, { maxPages: 2 }))!;
const { reading } = await readOfferDetails(ai, { companyName: "Nordpart sp. z o.o.", text });
const proposal = checkOfferDetails(text, reading);
console.log(`      sample document, as read and checked: ${JSON.stringify(proposal)}`);
report(proposal.companyDetails === "Nordpart sp. z o.o.\nul. Przykładowa 1, 40-001 Katowice\nNIP 0000000000", "details", "the seller's name, address and tax number, and nothing of the buyer's");
report(!JSON.stringify(proposal).includes("Rolmet") && !JSON.stringify(proposal).includes("1111111111"), "details", "no buyer details anywhere in the proposal");
report(proposal.bankDetails === null, "details", "no bank details offered: none are printed on this document");
report(proposal.currency === "PLN" && proposal.vatRate === 23 && proposal.offerLanguage === "pl", "details", `currency ${proposal.currency}, VAT ${proposal.vatRate}, language ${proposal.offerLanguage}`);

console.log(differences === 0 ? "\nAll as expected." : `\n${differences} difference(s): read the lines marked DIFF.`);
process.exit(differences === 0 ? 0 : 1);
