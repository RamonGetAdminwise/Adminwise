import { proposePriceListColumns, type AiClient } from "@adminwise/ai";
import type { CustomerScope, PriceListMapping } from "@adminwise/db";
import { applyMapping, proposeMapping, readPriceListFile, validMapping, type SheetTable } from "./price-list";

export interface ImportSummary {
  priceListId: string;
  /** Null when neither the column titles nor the model could tell: the customer then picks the columns. */
  mapping: PriceListMapping | null;
  itemCount: number;
  skippedCount: number;
}

/**
 * Takes in an uploaded price list as a draft.
 *
 *   1. Read the sheet and find the header row.
 *   2. Work out the columns: from the column titles; if those say nothing, ask
 *      the model, which answers with column numbers only.
 *   3. Copy the items by code and store the draft with what could not be read.
 *
 * Nothing uses the draft until the customer has seen the preview and confirmed
 * it (scope.activatePriceList). Throws PriceListError when the file is not a
 * readable workbook.
 */
export async function importPriceList(
  scope: CustomerScope,
  ai: AiClient,
  input: { fileName: string; bytes: Uint8Array; currency: string },
): Promise<ImportSummary> {
  const table = await readPriceListFile(input.bytes);
  let mapping: PriceListMapping | null = proposeMapping(table);

  if (!mapping) {
    const runId = await scope.startJobRun("price-list-columns");
    try {
      const { columns, usage } = await proposePriceListColumns(ai, {
        headers: table.headers,
        sampleRows: table.rows.slice(0, 6).map((r) => r.cells.map((c) => (c === null ? "" : String(c)))),
      });
      const candidate = { ...columns, name: columns.name ?? -1, price: columns.price ?? -1 };
      if (columns.name !== null && columns.price !== null && validMapping(table, candidate)) {
        mapping = { ...candidate, source: "model" };
      }
      await scope.finishJobRun(runId, { status: "succeeded", ...usage, outcome: mapping ? "columns_found" : "columns_unclear" });
    } catch (error) {
      // The model being unavailable must not block the upload: the customer picks the columns by hand.
      const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "Unknown error";
      await scope.finishJobRun(runId, { status: "failed", error: reason });
    }
  }

  const { items, skipped } = mapping ? applyMapping(table, mapping) : { items: [], skipped: [] };
  const priceListId = await scope.createPriceListDraft({
    fileName: input.fileName.slice(0, 200),
    currency: input.currency,
    mapping,
    raw: table,
    items,
    skipped,
  });
  return { priceListId, mapping, itemCount: items.length, skippedCount: skipped.length };
}

/**
 * The customer chose the columns themselves (or corrected the proposal) on the
 * preview page: read the stored sheet again with their mapping.
 * Returns false when there is no draft or the columns do not fit the sheet.
 */
export async function remapPriceList(
  scope: CustomerScope,
  columns: Omit<PriceListMapping, "source">,
): Promise<boolean> {
  const draft = await scope.getPriceListByStatus("draft");
  if (!draft?.raw) return false;
  const table: SheetTable = draft.raw;
  if (!validMapping(table, columns)) return false;
  const mapping: PriceListMapping = { ...columns, source: "customer" };
  const { items, skipped } = applyMapping(table, mapping);
  return scope.remapPriceListDraft(draft.id, { mapping, items, skipped });
}
