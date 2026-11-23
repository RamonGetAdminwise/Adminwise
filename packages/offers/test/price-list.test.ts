import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  applyMapping,
  formatMoney,
  parseAmount,
  percentOf,
  PriceListError,
  proposeMapping,
  readPriceListFile,
  validMapping,
  type PriceItem,
  type SkippedRow,
} from "../src";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/nordpart");
const expected = JSON.parse(readFileSync(path.join(fixtures, "price-list.json"), "utf8")) as {
  headerRow: number;
  items: Omit<PriceItem, "position">[];
  skipped: SkippedRow[];
};

/** A small workbook built in the test, for layouts other than Nordpart's. */
async function workbook(rows: (string | number | null)[][], sheetName = "Sheet1"): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

describe("amounts", () => {
  it("reads prices the way people type them, in the smallest unit", () => {
    expect(parseAmount(1234.5)).toBe(123450);
    expect(parseAmount(0.1 + 0.2)).toBe(30);
    expect(parseAmount("1 234,50 zł")).toBe(123450);
    expect(parseAmount("1 234,50")).toBe(123450);
    expect(parseAmount("1,234.50")).toBe(123450);
    expect(parseAmount("1.234,50")).toBe(123450);
    expect(parseAmount("12,5")).toBe(1250);
    expect(parseAmount("EUR 99")).toBe(9900);
    expect(parseAmount("1.234.567")).toBe(123456700);
    expect(parseAmount("2,345")).toBe(null); // two thousand, or two point three four five?
    expect(parseAmount("12,345")).toBe(null);
    expect(parseAmount("1234,567")).toBe(123457);
  });

  it("never guesses", () => {
    for (const unclear of ["", "na zapytanie", "-", "-5", "1.234", "12-15", null, undefined, Number.NaN, -1]) {
      expect(parseAmount(unclear), String(unclear)).toBeNull();
    }
  });

  it("formats and takes percentages exactly", () => {
    expect(formatMoney(123450, "PLN", "pl")).toBe("1 234,50 PLN");
    expect(formatMoney(123450, "PLN", "en")).toBe("1,234.50 PLN");
    expect(formatMoney(5, "EUR", "en")).toBe("0.05 EUR");
    expect(percentOf(10000, 23)).toBe(2300);
    expect(percentOf(999, 10)).toBe(100); // 99.9 rounds half up
    expect(percentOf(12345, 8.5)).toBe(1049); // 1049.325
    expect(percentOf(0, 23)).toBe(0);
  });
});

describe("Nordpart's own price list (Polish titles, title block, group headings, gross column)", () => {
  it("finds the header row and the columns from the header words", async () => {
    const table = await readPriceListFile(readFileSync(path.join(fixtures, "price-list.xlsx")));
    expect(table.sheetName).toBe("Cennik 2026");
    expect(table.headerRow).toBe(expected.headerRow);
    expect(table.headers).toEqual(["Indeks", "Nazwa towaru", "J.m.", "Cena netto PLN", "Cena brutto PLN", "Inne nazwy"]);
    // Net price, not the gross column next to it.
    expect(proposeMapping(table)).toEqual({ code: 0, name: 1, unit: 2, price: 3, aliases: 5, source: "headers" });
  });

  it("copies all 120 items exactly and reports the two rows it cannot use", async () => {
    const table = await readPriceListFile(readFileSync(path.join(fixtures, "price-list.xlsx")));
    const { items, skipped } = applyMapping(table, proposeMapping(table)!);

    expect(items).toHaveLength(120);
    expect(items.map((item) => ({ code: item.code, name: item.name, unit: item.unit, netPriceCents: item.netPriceCents, aliases: item.aliases }))).toEqual(expected.items);
    expect(items.map((i) => i.position)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    // "na zapytanie" is not a price; a second PZ-40 would make the code ambiguous.
    expect(skipped).toEqual(expected.skipped);
    // Group headings ("Pompy hydrauliczne") are neither items nor errors.
    expect(items.find((i) => i.name === "Pompy hydrauliczne")).toBeUndefined();

    expect(items.find((i) => i.code === "PZ-40")).toMatchObject({ name: "Pompa hydrauliczna zębata PZ-40", unit: "szt.", aliases: ["hydraulic gear pump PZ-40"] });
    expect(items.find((i) => i.code === "U-22")!.netPriceCents).toBe(320 + 45 * 7 * 10);
  });
});

describe("other layouts", () => {
  it("reads an English list without item codes", async () => {
    const table = await readPriceListFile(
      await workbook([
        ["Description", "Unit", "Price (EUR)"],
        ["Day rate senior designer", "day", 640],
        ["Logo package", "pc", "1,250.00"],
      ]),
    );
    const mapping = proposeMapping(table)!;
    expect(mapping).toMatchObject({ code: null, name: 0, unit: 1, price: 2, aliases: null });
    expect(applyMapping(table, mapping).items).toEqual([
      { position: 1, code: "", name: "Day rate senior designer", unit: "day", netPriceCents: 64000, aliases: [] },
      { position: 2, code: "", name: "Logo package", unit: "pc", netPriceCents: 125000, aliases: [] },
    ]);
  });

  it("does not guess when the headers say nothing: the model is asked and the customer confirms", async () => {
    const table = await readPriceListFile(
      await workbook([
        ["A", "B", "C"],
        ["X-1", "Widget", 10],
        ["X-2", "Gadget", 12.5],
      ]),
    );
    expect(proposeMapping(table)).toBeNull();
    // A mapping from elsewhere is checked against the sheet before it is used.
    expect(validMapping(table, { code: 0, name: 1, unit: null, price: 2, aliases: null })).toBe(true);
    expect(validMapping(table, { code: 0, name: 1, unit: null, price: 7, aliases: null })).toBe(false);
    expect(validMapping(table, { code: 1, name: 1, unit: null, price: 2, aliases: null })).toBe(false);
    expect(applyMapping(table, { code: 0, name: 1, unit: null, price: 2, aliases: null, source: "customer" }).items).toHaveLength(2);
  });

  it("uses what a formula calculated, and skips an empty first sheet", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Notes").addRow(["only one row here"]);
    const sheet = book.addWorksheet("Prices");
    sheet.addRow(["Code", "Name", "Net price"]);
    sheet.addRow(["A-1", "Bracket", { formula: "2*3.5", result: 7 }]);
    const table = await readPriceListFile(new Uint8Array(await book.xlsx.writeBuffer()));
    expect(table.sheetName).toBe("Prices");
    expect(applyMapping(table, proposeMapping(table)!).items[0]).toMatchObject({ code: "A-1", netPriceCents: 700 });
  });

  it("says plainly when a file is not a price list", async () => {
    await expect(readPriceListFile(new TextEncoder().encode("not an excel file"))).rejects.toMatchObject({ reason: "not_a_workbook" });
    await expect(readPriceListFile(await workbook([["just a title"]]))).rejects.toBeInstanceOf(PriceListError);
  });
});
