/**
 * Money is handled in the smallest unit (grosz, cent) as whole numbers, so
 * sums and percentages are exact and never depend on floating point.
 */

/**
 * Reads an amount from a spreadsheet cell and returns it in the smallest unit.
 * Returns null when the cell is empty, negative or not clearly a number: a
 * price that cannot be read with certainty is never guessed.
 *
 *   1234.5        -> 123450      "1 234,50 zł" -> 123450
 *   "1,234.50"    -> 123450      "1.234,50"    -> 123450
 *   "12,5"        -> 1250        "1.234"       -> null (thousands or decimals? unclear)
 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  }
  if (typeof value !== "string") return null;
  // Drop currency names and symbols and every kind of space; keep digits and separators.
  const text = value.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(text) || text.includes("-")) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let whole: string;
  let fraction = "";
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the later one is the decimal separator, the other groups thousands.
    const decimalAt = Math.max(lastComma, lastDot);
    whole = text.slice(0, decimalAt);
    fraction = text.slice(decimalAt + 1);
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? "," : ".";
    const parts = text.split(separator);
    const last = parts[parts.length - 1]!;
    if (parts.length > 2) {
      // "1.234.567": only grouping.
      if (!parts.slice(1).every((p) => p.length === 3)) return null;
      whole = text;
    } else if (last.length === 3 && parts[0]!.length <= 3) {
      // "1.234" or "1,234": a thousand or a decimal with three places? Do not guess.
      return null;
    } else {
      whole = parts[0]!;
      fraction = last;
    }
  } else {
    whole = text;
  }
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 4) return null;
  if (whole === "" && fraction === "") return null;
  // Round half up on the third decimal, in whole numbers.
  const thousandths = Number(whole || "0") * 1000 + Number((fraction + "000").slice(0, 3));
  const cents = Math.floor((thousandths + 5) / 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** No-break and narrow no-break space, which number formatting uses between thousands. */
const GROUP_SPACES = new RegExp("[\\u00a0\\u202f]", "g");

/** "1 234,50 PLN" in Polish, "1,234.50 PLN" in English. */
export function formatMoney(cents: number, currency: string, language: string): string {
  const amount = new Intl.NumberFormat(language === "pl" ? "pl-PL" : "en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  })
    .format(cents / 100)
    // One plain space as group separator in every environment, so documents and tests agree.
    .replace(GROUP_SPACES, " ");
  return `${amount} ${currency}`;
}

/** A percentage of an amount, rounded half up to the smallest unit. `percent` may have two decimals (23, 8.5, 12.25). */
export function percentOf(cents: number, percent: number): number {
  const hundredths = Math.round(percent * 100);
  return Math.floor((cents * hundredths + 5000) / 10000);
}
