import { readOfferDetails, type AiClient, type OfferDetailsReading } from "@adminwise/ai";
import { OFFER_LANGUAGES, type CustomerScope, type OfferProposal } from "@adminwise/db";
import { extractPdfText } from "./pdf-text";

export const MAX_SAMPLE_OFFER_BYTES = 5 * 1024 * 1024;

/** Lower case, with every run of spaces, tabs and line breaks as one space. */
const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Keeps from the model's reading only what is printed in the document.
 * A line the document does not contain is dropped, never corrected; whether a
 * printed line belongs to the seller is for the owner to confirm on the preview.
 */
export function checkOfferDetails(text: string, reading: OfferDetailsReading): OfferProposal {
  const document = flat(text);
  const printed = (value: string) => flat(value).length >= 2 && document.includes(flat(value));
  const block = (lines: string[]) => {
    const kept = [...new Set(lines.filter(printed).map((line) => line.trim()))];
    return kept.length ? kept.join("\n") : null;
  };

  let vatRate: number | null = null;
  if (reading.vatRate !== null && reading.vatRate >= 0 && reading.vatRate <= 100) {
    // "23%", "23 %", "23,00%"; not the "3%" inside "23%".
    const digits = String(reading.vatRate).replace(".", "[.,]");
    if (new RegExp(`(^|[^0-9.,])${digits}([.,]0+)?\\s?%`).test(text)) vatRate = reading.vatRate;
  }
  const currency =
    reading.currency && /^[A-Z]{3}$/.test(reading.currency) && printed(reading.currency) ? reading.currency : null;

  return {
    companyDetails: block(reading.companyLines),
    bankDetails: block(reading.bankLines),
    paymentTerms: reading.paymentTerms && printed(reading.paymentTerms) ? reading.paymentTerms : null,
    currency,
    vatRate,
    offerLanguage: OFFER_LANGUAGES.find((l) => l === reading.language) ?? null,
  };
}

/** True when the document gave nothing the owner would otherwise have to type. */
const empty = (p: OfferProposal) => !p.companyDetails && !p.bankDetails && !p.paymentTerms;

/**
 * Reads the company's own details from a past offer or invoice the owner
 * uploaded, and keeps them as a proposal until the owner says "use these".
 * The file and its text are used once and not stored.
 *
 *   "proposed"       details found; shown to the owner for confirmation
 *   "nothing_found"  the text was readable but held no usable details
 *   "unreadable"     not a PDF with text (a scan or a photo)
 */
export async function readSampleOffer(
  scope: CustomerScope,
  ai: AiClient,
  bytes: Uint8Array,
): Promise<"proposed" | "nothing_found" | "unreadable"> {
  const runId = await scope.startJobRun("offer-details");
  try {
    const text = await extractPdfText(bytes, { maxPages: 2 });
    if (!text) {
      await scope.finishJobRun(runId, { status: "succeeded", outcome: "unreadable" });
      return "unreadable";
    }
    const customer = await scope.getCustomer();
    const { reading, usage } = await readOfferDetails(ai, { companyName: customer.name, text });
    const proposal = checkOfferDetails(text, reading);
    const outcome = empty(proposal) ? "nothing_found" : "proposed";
    if (outcome === "proposed") await scope.setOfferProposal(proposal);
    await scope.finishJobRun(runId, { status: "succeeded", ...usage, outcome });
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "Unknown error";
    await scope.finishJobRun(runId, { status: "failed", error: reason });
    throw error;
  }
}

/** The owner said "use these": the found values replace the matching offer settings; the rest stay as they are. */
export async function applyOfferProposal(scope: CustomerScope): Promise<boolean> {
  const customer = await scope.getCustomer();
  const p = customer.offerProposal;
  if (!p) return false;
  await scope.updateOfferSettings({
    offerLanguage: p.offerLanguage ?? customer.offerLanguage,
    offerLayout: customer.offerLayout,
    currency: p.currency ?? customer.currency,
    vatRate: p.vatRate ?? customer.vatRate,
    paymentTerms: p.paymentTerms ?? customer.paymentTerms,
    offerValidDays: customer.offerValidDays,
    offerNumberPattern: customer.offerNumberPattern,
    companyDetails: p.companyDetails ?? customer.companyDetails,
    bankDetails: p.bankDetails ?? customer.bankDetails,
    offerFooter: customer.offerFooter,
    brandColor: customer.brandColor,
  });
  await scope.setOfferProposal(null);
  return true;
}
