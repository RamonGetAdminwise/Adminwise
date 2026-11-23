import { percentOf } from "./money";

/**
 * The arithmetic of an offer. Everything here is done by code, in whole
 * numbers of the smallest currency unit: the model never calculates, and never
 * supplies a price. Prices come from the price list, quantities from the
 * sender's request.
 */

export interface PricedItem {
  code: string;
  name: string;
  unit: string;
  netPriceCents: number;
}

export interface OfferLine {
  position: number;
  code: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface OfferTotals {
  /** Sum of the lines. */
  netCents: number;
  discountPercent: number;
  discountCents: number;
  /** Net after discount: the amount VAT is charged on. */
  netAfterDiscountCents: number;
  vatRate: number;
  vatCents: number;
  grossCents: number;
}

/** Quantity (up to three decimals, for metres or kilograms) times unit price, rounded half up. */
export function lineTotal(quantity: number, unitPriceCents: number): number {
  const thousandths = Math.round(quantity * 1000);
  return Math.floor((thousandths * unitPriceCents + 500) / 1000);
}

export function buildOffer(
  requested: { item: PricedItem; quantity: number }[],
  rates: { discountPercent: number; vatRate: number },
): { lines: OfferLine[]; totals: OfferTotals } {
  const lines = requested.map(({ item, quantity }, index) => ({
    position: index + 1,
    code: item.code,
    name: item.name,
    unit: item.unit,
    quantity,
    unitPriceCents: item.netPriceCents,
    lineTotalCents: lineTotal(quantity, item.netPriceCents),
  }));
  const netCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const discountCents = rates.discountPercent > 0 ? percentOf(netCents, rates.discountPercent) : 0;
  const netAfterDiscountCents = netCents - discountCents;
  const vatCents = percentOf(netAfterDiscountCents, rates.vatRate);
  return {
    lines,
    totals: {
      netCents,
      discountPercent: rates.discountPercent,
      discountCents,
      netAfterDiscountCents,
      vatRate: rates.vatRate,
      vatCents,
      grossCents: netAfterDiscountCents + vatCents,
    },
  };
}

/** "OF/{YYYY}/{NNN}" with year 2026 and counter 7 -> "OF/2026/007". */
export function formatOfferNumber(pattern: string, year: number, counter: number): string {
  return pattern.replaceAll("{YYYY}", String(year)).replaceAll("{NNN}", String(counter).padStart(3, "0"));
}

/** A quantity as people write it: "12", "2.5". Whole numbers without decimals. */
export function formatQuantity(quantity: number, language: string): string {
  return new Intl.NumberFormat(language === "pl" ? "pl-PL" : "en-GB", { maximumFractionDigits: 3, useGrouping: false }).format(quantity);
}
