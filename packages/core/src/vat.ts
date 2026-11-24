/**
 * VAT numbers of our own customers, for our invoices to them.
 *
 * A VAT number is checked in two steps: its shape (by code, per country), then
 * the EU's public register, VIES. Only "the register says valid" counts as
 * valid; a register that cannot be reached is "unverified", never "valid".
 *
 * What is sent to VIES: the country code and the VAT number, nothing else.
 */

/** EU member states by ISO code. Greece is "GR" here; VIES calls it "EL". */
export const EU_COUNTRIES: Record<string, string> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", HR: "Croatia", CY: "Cyprus", CZ: "Czechia", DK: "Denmark",
  EE: "Estonia", FI: "Finland", FR: "France", DE: "Germany", GR: "Greece", HU: "Hungary", IE: "Ireland",
  IT: "Italy", LV: "Latvia", LT: "Lithuania", LU: "Luxembourg", MT: "Malta", NL: "Netherlands", PL: "Poland",
  PT: "Portugal", RO: "Romania", SK: "Slovakia", SI: "Slovenia", ES: "Spain", SE: "Sweden",
};
/** A billing country outside the EU: no VAT number check exists for it. */
export const OTHER_COUNTRY = "OTHER";

/** The part after the country prefix. */
const SHAPES: Record<string, RegExp> = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, HR: /^\d{11}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/,
  DK: /^\d{8}$/, EE: /^\d{9}$/, FI: /^\d{8}$/, FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/, DE: /^\d{9}$/, GR: /^\d{9}$/,
  HU: /^\d{8}$/, IE: /^[0-9A-Z+*]{8,9}$/, IT: /^\d{11}$/, LV: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/, LU: /^\d{8}$/,
  MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/, RO: /^\d{2,10}$/, SK: /^\d{10}$/,
  SI: /^\d{8}$/, ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, SE: /^\d{12}$/,
};

const viesCode = (country: string) => (country === "GR" ? "EL" : country);

/**
 * "PL 123-456-78-90" -> "1234567890". Spaces, dots and dashes are dropped, and
 * so is the country prefix when the owner typed it. Null when the country is
 * not in the EU or the number does not have that country's shape.
 */
export function normalizeVatNumber(country: string, input: string): string | null {
  const shape = SHAPES[country];
  if (!shape) return null;
  let number = input.toUpperCase().replace(/[\s.-]/g, "");
  if (number.startsWith(country) || number.startsWith(viesCode(country))) number = number.slice(2);
  return shape.test(number) ? number : null;
}

export type VatStatus = "none" | "valid" | "invalid" | "unverified";

export interface VatCheck {
  status: Exclude<VatStatus, "none">;
  /** The name the register holds for this number, when it gives one (some countries do not). */
  registeredName: string | null;
}

const VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

/**
 * Asks VIES whether a (already normalised) VAT number is registered.
 * Never throws: when the register cannot be reached, is overloaded or answers
 * something unexpected, the result is "unverified" and the caller tries again later.
 */
export async function checkVatNumber(
  country: string,
  number: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<VatCheck> {
  const unverified: VatCheck = { status: "unverified", registeredName: null };
  try {
    const response = await fetchFn(VIES_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ countryCode: viesCode(country), vatNumber: number }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return unverified;
    const answer = (await response.json()) as { valid?: unknown; name?: unknown; actionSucceed?: unknown };
    // An error answer ("the member state's register is unavailable") has no "valid" at all.
    if (typeof answer.valid !== "boolean") return unverified;
    if (!answer.valid) return { status: "invalid", registeredName: null };
    const name = typeof answer.name === "string" ? answer.name.replace(/\s+/g, " ").trim() : "";
    return { status: "valid", registeredName: name && name !== "---" ? name.slice(0, 200) : null };
  } catch {
    return unverified;
  }
}

/**
 * How VAT is handled on our invoice to a customer, from where we are, where
 * they are and whether their VAT number is valid.
 *
 *   domestic        same country as us: our VAT, with or without a VAT number
 *   reverse_charge  another EU country and a valid VAT number: no VAT charged,
 *                   the customer accounts for it
 *   eu_with_vat     another EU country without a valid VAT number: VAT is charged
 *   outside_eu      not in the EU
 *   unknown         no billing country yet
 *
 * This names the case only. The rate and the invoice wording come from the
 * billing provider's tax settings, to be confirmed with the accountant.
 */
export type TaxTreatment = "domestic" | "reverse_charge" | "eu_with_vat" | "outside_eu" | "unknown";

export function taxTreatment(sellerCountry: string, customerCountry: string, vatStatus: VatStatus): TaxTreatment {
  if (!customerCountry) return "unknown";
  if (customerCountry === sellerCountry) return "domestic";
  if (!EU_COUNTRIES[customerCountry]) return "outside_eu";
  return vatStatus === "valid" ? "reverse_charge" : "eu_with_vat";
}
