import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { applyMapping, matchByCode, parseAmount, proposeMapping, readPriceListFile, type SheetTable } from "../src";

/** Faults found by the independent review of 2026-11-24: prices and item codes that were misread. */

describe("a price cell must hold one number", () => {
  it("refuses cells where two numbers or stray words would be glued into one price", () => {
    expect(parseAmount("50 zł / 100 szt")).toBeNull(); // was 50 100,00
    expect(parseAmount("45 zł (od 10 szt. 40 zł)")).toBeNull(); // was 4 510,40
    expect(parseAmount("2 x 50")).toBeNull(); // was 250
    expect(parseAmount("ca. 50")).toBeNull(); // was 0,50
    expect(parseAmount("approx. 1200 PLN")).toBeNull(); // was 0,12
    expect(parseAmount("Seria 500")).toBeNull(); // a section heading, was an item at 500
    expect(parseAmount("od 12,50 zł")).toBeNull();
    expect(parseAmount("-5")).toBeNull();
  });

  it("still reads the ways people really write one price", () => {
    expect(parseAmount("1 234,50 zł")).toBe(123450);
    expect(parseAmount("12,50 zł/szt.")).toBe(1250);
    expect(parseAmount("EUR 99")).toBe(9900);
    expect(parseAmount("€ 1.234,50")).toBe(123450);
    expect(parseAmount("99.90 EUR")).toBe(9990);
    expect(parseAmount("1 250 Kč")).toBe(125000);
    expect(parseAmount("0")).toBe(0);
  });

  it("does not keep a price that rounding to whole cents would change", () => {
    expect(parseAmount(0.0375)).toBeNull(); // 10 000 pieces would be 400 instead of 375
    expect(parseAmount(0.004)).toBeNull(); // would be offered at 0,00
    expect(parseAmount("0,0375")).toBeNull();
    // Ordinary prices with a third decimal are rounded as before.
    expect(parseAmount(12.3456)).toBe(1235);
    expect(parseAmount(1.005)).toBe(101); // was 1,00
  });
});

describe("item codes made of digits only", () => {
  const items = [
    { id: "a", code: "100", name: "Zawór kulowy", aliases: [] },
    { id: "b", code: "2026", name: "Kalendarz", aliases: [] },
    { id: "c", code: "PZ-40", name: "Pompa zębata", aliases: [] },
    { id: "d", code: "10234", name: "Wąż hydrauliczny 100 mm", aliases: [] },
  ];
  it("never match by themselves: a size or a year is not an order", () => {
    expect(matchByCode("wąż hydrauliczny 100 mm", items)).toBeNull(); // was the valve with code 100
    expect(matchByCode("dostawa w 2026", items)).toBeNull();
    expect(matchByCode("10234", items)).toBeNull(); // goes to the model together with the item names
    expect(matchByCode("pompa pz 40", items)).toMatchObject({ id: "c" });
  });
});

describe("which column is the price", () => {
  const table = (headers: string[], row: (string | number)[]): SheetTable => ({
    sheetName: "Cennik",
    headerRow: 1,
    headers,
    rows: [1, 2, 3].map((n) => ({ row: n + 1, cells: row })),
  });

  it("is not the weight, the VAT rate or the stock that stands before it", () => {
    expect(proposeMapping(table(["Kod", "Nazwa", "Waga netto", "Cena netto"], ["A-1", "Zawór", 2.5, 120]))!.price).toBe(3);
    expect(proposeMapping(table(["Kod", "Nazwa", "Stawka VAT", "Cena"], ["A-1", "Zawór", 23, 120]))!.price).toBe(3);
    expect(proposeMapping(table(["Code", "Name", "Net weight", "VAT rate", "Price"], ["A-1", "Valve", 2.5, 23, 120]))!.price).toBe(4);
    expect(proposeMapping(table(["Code", "Omschrijving", "Tarief (excl. btw)"], ["A-1", "Advies", 95]))!.price).toBe(2);
    expect(proposeMapping(table(["Kod", "Nazwa", "Cena netto (bez VAT)"], ["A-1", "Zawór", 120]))!.price).toBe(2);
  });

  it("a net price is preferred over a gross one, wherever it stands", () => {
    expect(proposeMapping(table(["Nazwa", "Cena brutto", "Cena netto"], ["Zawór", 147.6, 120]))!.price).toBe(2);
  });

  it("a row whose price cell is not one number is left out and shown, not guessed", () => {
    const t = table(["Kod", "Nazwa", "Cena netto"], ["A-1", "Zawór", 120]);
    t.rows = [
      { row: 2, cells: ["A-1", "Zawór", "120,00 zł"] },
      { row: 3, cells: ["A-2", "Zawór duży", "ca. 500"] },
      { row: 4, cells: ["", "Seria 500", "Seria 500"] },
    ];
    const { items, skipped } = applyMapping(t, proposeMapping({ ...t, rows: [t.rows[0]!] })!);
    expect(items.map((i) => i.code)).toEqual(["A-1"]);
    expect(skipped).toEqual([{ row: 3, reason: "price_not_readable" }, { row: 4, reason: "price_not_readable" }]);
  });
});

describe("which sheet is read", () => {
  it("skips a hidden sheet with old prices and reads the visible one", async () => {
    const workbook = new ExcelJS.Workbook();
    const old = workbook.addWorksheet("Stare ceny");
    old.state = "hidden";
    old.addRows([["Kod", "Nazwa", "Cena netto"], ["A-1", "Zawór", 100], ["A-2", "Pompa", 200]]);
    const current = workbook.addWorksheet("Cennik 2026");
    current.addRows([["Kod", "Nazwa", "Cena netto"], ["A-1", "Zawór", 120], ["A-2", "Pompa", 240]]);
    const table = await readPriceListFile(new Uint8Array(await workbook.xlsx.writeBuffer()));
    expect(table.sheetName).toBe("Cennik 2026");
    expect(table.rows[0]!.cells[2]).toBe(120);
    expect(table.truncated).toBeUndefined();
  });
});
