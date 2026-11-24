/**
 * Money is handled in the smallest unit (grosz, cent) as whole numbers, so
 * sums and percentages are exact and never depend on floating point.
 */

/** Currency names and signs that may stand before or after a price. */
const CURRENCY = "(?:z\\u0142|zl|pln|eur|euro|\\u20ac|usd|\\$|gbp|\\u00a3|czk|k\\u010d|kc|chf|sek|nok|dkk|huf|ron)\\.?";
/** One number, optionally with a currency and a "per unit" ending: "1 234,50 zł", "EUR 12.50", "12,50 zł/szt.". */
const ONE_AMOUNT = new RegExp(
  `^(?:${CURRENCY}\\s*)?(\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+(?:[.,]\\d+)?|\\d[\\d.,]*)\\s*(?:${CURRENCY})?(?:\\s*/\\s*[\\p{L}.]{1,10})?$`,
  "iu",
);

/** Rounding to whole cents may not change a price by more than this share (0.0375 is not 0.04). */
const MAX_ROUNDING_SHARE = 0.01;

/**
 * Reads an amount from a spreadsheet cell and returns it in the smallest unit.
 * Returns null when the cell is empty, negative or not clearly ONE number: a
 * price that cannot be read with certainty is never guessed.
 *
 *   1234.5        -> 123450      "1 234,50 zł" -> 123450
 *   "1,234.50"    -> 123450      "1.234,50"    -> 123450
 *   "12,5"        -> 1250        "1.234"       -> null (thousands or decimals? unclear)
 *   "ca. 50"      -> null        "50 zł / 100 szt" -> null (two numbers, or words around the number)
 *   0.0375        -> null        (a price below a cent cannot be kept exactly)
 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    // Through thousandths as text, so 1.005 is 1.01 and not 1.00 (binary fractions).
    const cents = Math.round(Number((value * 1000).toFixed(3)) / 10);
    if (!Number.isSafeInteger(cents)) return null;
    return value > 0 && Math.abs(cents / 100 - value) / value > MAX_ROUNDING_SHARE ? null : cents;
  }
  if (typeof value !== "string") return null;
  // The cell must hold one number and nothing else but a currency ("ca. 50", "2 x 50" and "Seria 500" are not prices).
  const one = ONE_AMOUNT.exec(value.trim());
  if (!one) return null;
  const text = one[1]!.replace(/[ \u00a0\u202f]/g, "");

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
  if (!Number.isSafeInteger(cents)) return null;
  const exact = Number(`${whole || "0"}.${fraction || "0"}`);
  return exact > 0 && Math.abs(cents / 100 - exact) / exact > MAX_ROUNDING_SHARE ? null : cents;
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
