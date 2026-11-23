import { readFileSync } from "node:fs";
import path from "node:path";
import { checkOfferAccepted, createBedrockClient, detectQuoteRequest, matchItems } from "../packages/ai/src";
import { loadConfig } from "../packages/core/src/config";
import { applyMapping, matchByCode, proposeMapping, rankCandidates, readPriceListFile } from "../packages/offers/src";

/**
 * `pnpm check:quotes`: runs the Nordpart quote requests through the REAL model
 * and compares its answers with what the fixtures expect. The normal tests use
 * a recorded stand-in, so they prove the pipeline; this proves the prompts.
 * It needs the AWS keys in .env and costs a few cents. It prints the model's
 * decisions for invented fixture mail only, and no keys.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}

interface Fixture {
  id: string;
  subject: string;
  bodyText: string;
  expected: {
    accepts?: boolean;
    quote: { isQuote: boolean; items: { request: string; quantity: number | null }[] };
    matches: { request: string; result: "match" | "ambiguous" | "none"; code: string | null }[];
    note: string;
  };
}

const fixtures = path.resolve(import.meta.dirname, "../fixtures/nordpart");
const quotes = JSON.parse(readFileSync(path.join(fixtures, "quotes.json"), "utf8")) as Fixture[];
const table = await readPriceListFile(new Uint8Array(readFileSync(path.join(fixtures, "price-list.xlsx"))));
const items = applyMapping(table, proposeMapping(table)!).items.map((item, i) => ({ id: String(i), ...item }));

const { aws } = loadConfig();
const ai = createBedrockClient(aws);
let differences = 0;
const report = (ok: boolean, id: string, what: string) => {
  if (!ok) differences++;
  console.log(`${ok ? "ok  " : "DIFF"}  ${id}  ${what}`);
};

for (const f of quotes) {
  try {
    // An acceptance or a question inside an offer conversation.
    if (f.expected.accepts !== undefined) {
      const { accepted } = await checkOfferAccepted(ai, { companyName: "Nordpart sp. z o.o.", offerNumber: "OF/2026/001", subject: f.subject, body: f.bodyText });
      report(accepted === f.expected.accepts, f.id, `accepts the offer: ${accepted ? "yes" : "no"} (expected ${f.expected.accepts ? "yes" : "no"})`);
    }

    const detected = await detectQuoteRequest(ai, { companyName: "Nordpart sp. z o.o.", subject: f.subject, body: f.bodyText });
    report(detected.isQuoteRequest === f.expected.quote.isQuote, f.id, `quote request: ${detected.isQuoteRequest ? "yes" : "no"} (expected ${f.expected.quote.isQuote ? "yes" : "no"})`);
    if (!f.expected.quote.isQuote) continue;

    const quantities = detected.items.map((i) => i.quantity);
    const expectedQuantities = f.expected.quote.items.map((i) => i.quantity);
    report(JSON.stringify(quantities) === JSON.stringify(expectedQuantities), f.id, `items and quantities: ${JSON.stringify(detected.items.map((i) => [i.request, i.quantity]))}`);

    // The same matching steps as the worker: by code, then candidates to the model.
    const outcomes: string[] = [];
    const forModel: { request: string; candidates: typeof items }[] = [];
    for (const requested of detected.items) {
      const byCode = matchByCode(requested.request, items);
      if (byCode === "ambiguous") outcomes.push(`${requested.request} -> ambiguous (codes)`);
      else if (byCode) outcomes.push(`${requested.request} -> ${byCode.code} (by code)`);
      else {
        const candidates = rankCandidates(requested.request, items, 10);
        if (candidates.length === 0) outcomes.push(`${requested.request} -> not on the list (no candidates)`);
        else forModel.push({ request: requested.request, candidates });
      }
    }
    if (forModel.length > 0) {
      const { matches } = await matchItems(ai, {
        items: forModel.map((m) => ({ request: m.request, candidates: m.candidates.map((c) => ({ code: c.code, name: c.name, aliases: c.aliases, unit: c.unit })) })),
      });
      matches.forEach((match, i) => {
        const { request, candidates } = forModel[i]!;
        const code = match.result === "match" ? candidates[match.candidate - 1]!.code : null;
        // The model's wording of the request may differ from the fixture's: compare in order.
        const expected = f.expected.matches[i];
        const ok = expected ? expected.result === match.result && expected.code === code : false;
        report(ok, f.id, `model match: ${request} -> ${match.result}${code ? ` ${code}` : ""} (expected ${expected ? `${expected.result}${expected.code ? ` ${expected.code}` : ""}` : "no model call"})`);
      });
    } else if (f.expected.matches.length > 0) {
      report(false, f.id, `expected the model to be asked about "${f.expected.matches[0]!.request}", but it was settled without it`);
    }
    for (const line of outcomes) console.log(`        ${line}`);
  } catch (error) {
    report(false, f.id, error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "error");
  }
}
console.log(differences === 0 ? "RESULT: OK, the real model agrees with every fixture" : `RESULT: ${differences} difference(s) to look at`);
process.exit(differences === 0 ? 0 : 1);
