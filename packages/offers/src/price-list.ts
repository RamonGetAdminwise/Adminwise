import ExcelJS from "exceljs";
import { parseAmount } from "./money";

/**
 * Reading a customer's own price list.
 *
 * The customer uploads the Excel file they already have. We find the header
 * row and propose which column is the item code, the name, the unit and the
 * price. The customer confirms a preview once. After that the values are
 * copied cell by cell by this code: no model ever reads or writes a price.
 */

export type Cell = string | number | null;

export interface SheetTable {
  sheetName: string;
  /** 1-based sheet row number of the header row. */
  headerRow: number;
  headers: string[];
  /** Data rows below the header, each with its 1-based sheet row number. */
  rows: { row: number; cells: Cell[] }[];
}

export interface ColumnMapping {
  /** Column indexes (0-based) into `headers`. Name and price are required; the others are optional. */
  code: number | null;
  name: number;
  unit: number | null;
  price: number;
  aliases: number | null;
  /** How the mapping was found: from the header words, proposed by the model, or set by the customer. */
  source: "headers" | "model" | "customer";
}

export interface PriceItem {
  position: number;
  code: string;
  name: string;
  unit: string;
  netPriceCents: number;
  aliases: string[];
}

export type SkipReason = "no_name" | "price_not_readable" | "duplicate_code";
export interface SkippedRow {
  row: number;
  reason: SkipReason;
}

export const MAX_PRICE_LIST_ROWS = 5000;
export const MAX_PRICE_LIST_BYTES = 5 * 1024 * 1024;

/** Header words per column, in the languages our customers keep their lists in (pl, en, de, nl, cs). */
const HEADER_WORDS: Record<"code" | "name" | "unit" | "price" | "aliases", RegExp> = {
  code: /\b(kod|indeks|index|symbol|sku|nr\s*kat\w*|numer\s*kat\w*|item\s*(no|code|number)|code|art\.?\s*(nr|no)\.?|artikel\s*(nr|nummer)|artikelnummer|k[oó]d)\b/i,
  name: /\b(nazwa|opis|towar|produkt|name|description|product|item|bezeichnung|artikel|omschrijving|n[aá]zev|popis)\b/i,
  unit: /(^|\s)(j\.?\s?m\.?|jedn\w*|unit|uom|einheit|eenheid|jednotka|mj)(\s|\.|$)/i,
  price: /\b(cena|price|preis|prijs|netto|net)\b/i,
  aliases: /\b(alias\w*|synonim\w*|inne\s*nazwy|other\s*names|also\s*known|keywords?|s[łl]owa\s*kluczowe)\b/i,
};
const GROSS = /\b(brutto|gross|incl|inkl|z\s*vat|with\s*vat)\b/i;

function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    // A formula: use what Excel calculated. Rich text and links: use the visible text.
    if ("result" in value) return cellValue(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((part) => part.text).join("").trim() || null;
    if ("text" in value) return cellValue(value.text as ExcelJS.CellValue);
    if ("error" in value) return null;
  }
  return null;
}

const text = (cell: Cell | undefined): string => (cell === null || cell === undefined ? "" : String(cell).trim());

/** How many cells of a row look like column titles of a price list. */
function headerScore(cells: Cell[]): number {
  const titles = cells.map(text).filter(Boolean);
  if (titles.length < 2 || titles.some((t) => t.length > 60)) return 0;
  return Object.values(HEADER_WORDS).filter((pattern) => titles.some((t) => pattern.test(t))).length;
}

/**
 * Opens an .xlsx file and returns the first sheet that holds a table: its
 * header row and the rows below it. Throws an Error with a plain message when
 * the file is not a readable workbook or has no table.
 */
export async function readPriceListFile(bytes: Uint8Array): Promise<SheetTable> {
  if (bytes.byteLength > MAX_PRICE_LIST_BYTES) throw new PriceListError("too_large");
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs wants a Node Buffer; the cast only bridges its older type declarations.
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new PriceListError("not_a_workbook");
  }

  for (const sheet of workbook.worksheets) {
    const all: { row: number; cells: Cell[] }[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (all.length > MAX_PRICE_LIST_ROWS + 50) return;
      const cells: Cell[] = [];
      // row.values is 1-based with an empty first slot.
      const values = row.values as ExcelJS.CellValue[];
      for (let column = 1; column < values.length; column++) cells[column - 1] = cellValue(values[column]);
      for (let column = 0; column < cells.length; column++) cells[column] ??= null;
      if (cells.some((c) => c !== null)) all.push({ row: rowNumber, cells });
    });
    if (all.length < 2) continue;

    // The header is the row among the first 20 that looks most like column titles;
    // failing that, the first row with at least two text cells.
    const top = all.slice(0, 20);
    let header = top.reduce((best, candidate) => (headerScore(candidate.cells) > headerScore(best.cells) ? candidate : best), top[0]!);
    if (headerScore(header.cells) === 0) {
      header = top.find((r) => r.cells.filter((c) => typeof c === "string").length >= 2) ?? top[0]!;
    }
    const rows = all.filter((r) => r.row > header.row).slice(0, MAX_PRICE_LIST_ROWS);
    if (rows.length === 0) continue;
    const width = Math.max(header.cells.length, ...rows.map((r) => r.cells.length));
    const pad = (cells: Cell[]) => Array.from({ length: width }, (_, i) => cells[i] ?? null);
    return {
      sheetName: sheet.name,
      headerRow: header.row,
      headers: pad(header.cells).map((c, i) => text(c) || `Column ${i + 1}`),
      rows: rows.map((r) => ({ row: r.row, cells: pad(r.cells) })),
    };
  }
  throw new PriceListError("no_table");
}

export class PriceListError extends Error {
  constructor(readonly reason: "too_large" | "not_a_workbook" | "no_table") {
    super(`Price list could not be read: ${reason}`);
    this.name = "PriceListError";
  }
}

/** Share of the non-empty cells of a column that hold a readable amount. */
function amountShare(table: SheetTable, column: number): number {
  const filled = table.rows.map((r) => r.cells[column]).filter((c) => c !== null && c !== undefined);
  if (filled.length === 0) return 0;
  return filled.filter((c) => parseAmount(c) !== null).length / filled.length;
}

/**
 * Share of a column's cells that hold nothing but an amount: a number, or text
 * that reads as one with at most a currency name next to it ("12,50 zł").
 * An item name with a size in it ("Angle grinder 125 mm") is not an amount.
 */
function bareAmountShare(table: SheetTable, column: number): number {
  const filled = table.rows.map((r) => r.cells[column]).filter((c) => c !== null && c !== undefined);
  if (filled.length === 0) return 0;
  const bare = (c: Cell) =>
    typeof c === "number" || (typeof c === "string" && c.replace(/[^\p{L}]/gu, "").length <= 3 && parseAmount(c) !== null);
  return filled.filter(bare).length / filled.length;
}

/**
 * Proposes the column mapping from the header words alone. Returns null when
 * the name or the price column cannot be told from the headers; the caller
 * then asks the model, and in any case the customer confirms.
 */
export function proposeMapping(table: SheetTable): ColumnMapping | null {
  const find = (kind: keyof typeof HEADER_WORDS, taken: number[], accept: (column: number) => boolean = () => true) =>
    table.headers.findIndex((h, i) => !taken.includes(i) && HEADER_WORDS[kind].test(h) && accept(i));

  // Price first: a column titled like a price whose cells are amounts; a net price before a gross one.
  const priceColumns = table.headers
    .map((h, i) => ({ i, h }))
    .filter(({ i, h }) => HEADER_WORDS.price.test(h) && amountShare(table, i) >= 0.8);
  const price = (priceColumns.find(({ h }) => !GROSS.test(h)) ?? priceColumns[0])?.i ?? -1;
  if (price < 0) return null;

  const code = find("code", [price]);
  const aliases = find("aliases", [price, code]);
  const unit = find("unit", [price, code, aliases]);
  // The name is a text column: "Artikel" or "Item" may also title the code column, so skip what is taken.
  const name = find("name", [price, code, aliases, unit], (i) => bareAmountShare(table, i) < 0.5);
  if (name < 0) return null;

  const orNull = (index: number) => (index >= 0 ? index : null);
  return { code: orNull(code), name, unit: orNull(unit), price, aliases: orNull(aliases), source: "headers" };
}

/** Checks a mapping (from the model or the customer) against the sheet: columns must exist and differ. */
export function validMapping(table: SheetTable, mapping: Omit<ColumnMapping, "source">): boolean {
  const inRange = (i: number | null) => i === null || (Number.isInteger(i) && i >= 0 && i < table.headers.length);
  const used = [mapping.code, mapping.name, mapping.unit, mapping.price, mapping.aliases].filter((i): i is number => i !== null);
  return (
    [mapping.code, mapping.name, mapping.unit, mapping.price, mapping.aliases].every(inRange) &&
    mapping.name !== null &&
    mapping.price !== null &&
    new Set(used).size === used.length
  );
}

/**
 * Copies the items out of the sheet with a confirmed (or proposed) mapping.
 * Rows that cannot be read with certainty are not guessed: they are returned
 * in `skipped` with their sheet row number, so the customer can see and fix them.
 */
export function applyMapping(table: SheetTable, mapping: ColumnMapping): { items: PriceItem[]; skipped: SkippedRow[] } {
  const items: PriceItem[] = [];
  const skipped: SkippedRow[] = [];
  const seenCodes = new Set<string>();

  for (const { row, cells } of table.rows) {
    const name = text(cells[mapping.name]);
    const code = mapping.code === null ? "" : text(cells[mapping.code]);
    const priceCell = cells[mapping.price] ?? null;
    // Section titles and blank lines inside a list: nothing in the name and price columns.
    if (!name && priceCell === null && !code) continue;
    // A row with only a name is a group heading, not an item.
    if (name && priceCell === null && !code) continue;
    if (!name) {
      skipped.push({ row, reason: "no_name" });
      continue;
    }
    const netPriceCents = parseAmount(priceCell);
    if (netPriceCents === null) {
      skipped.push({ row, reason: "price_not_readable" });
      continue;
    }
    const key = code.toLowerCase();
    if (key && seenCodes.has(key)) {
      skipped.push({ row, reason: "duplicate_code" });
      continue;
    }
    if (key) seenCodes.add(key);
    items.push({
      position: items.length + 1,
      code,
      name,
      unit: mapping.unit === null ? "" : text(cells[mapping.unit]),
      netPriceCents,
      aliases:
        mapping.aliases === null
          ? []
          : text(cells[mapping.aliases])
              .split(/[;,|]/)
              .map((a) => a.trim())
              .filter(Boolean),
    });
  }
  return { items, skipped };
}
