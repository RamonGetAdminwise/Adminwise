import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPdfRenderer } from "../apps/worker/src/pdf";
import { buildOffer, renderOfferHtml, type OfferDocument } from "../packages/offers/src";

/**
 * `pnpm check:pdf`: proves the PDF engine (headless Chromium) works on this
 * machine or in this container, and writes one sample offer per layout and
 * language to a folder so a person can look at them.
 * The samples use invented Nordpart data. Usage: pnpm check:pdf [output folder]
 */
const out = path.resolve(process.argv[2] ?? "sample-offers");
mkdirSync(out, { recursive: true });

const { lines, totals } = buildOffer(
  [
    { item: { code: "PZ-40", name: "Pompa hydrauliczna zębata PZ-40", unit: "szt.", netPriceCents: 170000 }, quantity: 12 },
    { item: { code: "U-22", name: "Uszczelka gumowa U-22", unit: "szt.", netPriceCents: 3470 }, quantity: 30 },
    { item: { code: "WH-16", name: "Wąż hydrauliczny DN16 2SN", unit: "mb", netPriceCents: 11130 }, quantity: 2.5 },
  ],
  { discountPercent: 10, vatRate: 23 },
);
const base: OfferDocument = {
  kind: "offer", number: "OF/2026/001", date: "2026-11-24", validUntil: "2026-12-08", language: "pl", layout: "classic",
  brandColor: "#1f6f6b", logoDataUrl: null, companyName: "Nordpart sp. z o.o.",
  companyDetails: "Nordpart sp. z o.o.\nul. Przykładowa 1\n40-001 Katowice\nNIP 0000000000",
  recipient: ["Anna Kowalczyk", "Rolmet"], currency: "PLN", lines, totals,
  paymentTerms: "14 dni od daty faktury", bankDetails: "PL00 0000 0000 0000 0000 0000 0000", footer: "Dziękujemy za zapytanie.",
};

const pdf = createPdfRenderer();
let failed = false;
try {
  for (const layout of ["classic", "modern", "compact"] as const) {
    for (const language of ["pl", "en"]) {
      const bytes = await pdf.render(renderOfferHtml({ ...base, layout, language }));
      const ok = Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-" && bytes.byteLength > 5000;
      failed ||= !ok;
      const file = path.join(out, `offer_${layout}_${language}.pdf`);
      writeFileSync(file, bytes);
      console.log(`${ok ? "ok    " : "FAILED"}  ${layout} / ${language}: ${bytes.byteLength} bytes -> ${file}`);
    }
  }
  const confirmation = await pdf.render(renderOfferHtml({ ...base, kind: "order_confirmation", number: "OF/2026/001-C", sourceOfferNumber: "OF/2026/001", validUntil: null }));
  writeFileSync(path.join(out, "order_confirmation_classic_pl.pdf"), confirmation);
  console.log(`ok      order confirmation: ${confirmation.byteLength} bytes`);
} catch (error) {
  failed = true;
  console.log(`FAILED  ${error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : "error"}`);
} finally {
  await pdf.close();
}
console.log(failed ? "RESULT: FAILED" : "RESULT: OK");
process.exit(failed ? 1 : 0);
