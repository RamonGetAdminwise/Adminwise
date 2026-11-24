import { randomBytes } from "node:crypto";
import { createDb, forCustomer, system, type Db } from "@adminwise/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { checkVatNumber, EU_COUNTRIES, loadConfig, normalizeVatNumber, taxTreatment } from "../src";

/** A stand-in for the EU register: answers with one fixed reply and remembers what it was asked. */
function fakeVies(reply: unknown, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("VAT number shape", () => {
  it("accepts a number as people type it and stores it without prefix and punctuation", () => {
    expect(normalizeVatNumber("PL", "PL 000-000-00-00")).toBe("0000000000");
    expect(normalizeVatNumber("PL", "0000000000")).toBe("0000000000");
    expect(normalizeVatNumber("NL", "nl000000000b01")).toBe("000000000B01");
    expect(normalizeVatNumber("DE", "DE 000 000 000")).toBe("000000000");
    expect(normalizeVatNumber("AT", "ATU00000000")).toBe("U00000000");
    // Greece: "GR" for us, "EL" on the number.
    expect(normalizeVatNumber("GR", "EL000000000")).toBe("000000000");
  });

  it("refuses a number that does not fit the chosen country", () => {
    expect(normalizeVatNumber("PL", "12345")).toBeNull();
    expect(normalizeVatNumber("PL", "DE000000000")).toBeNull(); // a German number with Poland chosen
    expect(normalizeVatNumber("NL", "000000000")).toBeNull();
    expect(normalizeVatNumber("US", "000000000")).toBeNull(); // no EU register for it
    expect(normalizeVatNumber("PL", "")).toBeNull();
  });

  it("knows a shape for every EU member state", () => {
    expect(Object.keys(EU_COUNTRIES)).toHaveLength(27);
    for (const country of Object.keys(EU_COUNTRIES)) expect(normalizeVatNumber(country, "!"), country).toBeNull();
  });
});

describe("asking the EU register", () => {
  it("sends only the country and the number, and reports valid with the registered name", async () => {
    const vies = fakeVies({ countryCode: "PL", vatNumber: "0000000000", valid: true, name: "NORDPART  SP. Z O.O.", address: "KATOWICE" });
    expect(await checkVatNumber("PL", "0000000000", vies.fetchFn)).toEqual({ status: "valid", registeredName: "NORDPART SP. Z O.O." });
    expect(vies.calls).toEqual([
      { url: "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number", body: { countryCode: "PL", vatNumber: "0000000000" } },
    ]);
  });

  it("asks for Greece under the register's own code, and copes with countries that give no name", async () => {
    const vies = fakeVies({ valid: true, name: "---" });
    expect(await checkVatNumber("GR", "000000000", vies.fetchFn)).toEqual({ status: "valid", registeredName: null });
    expect(vies.calls[0]!.body).toEqual({ countryCode: "EL", vatNumber: "000000000" });
  });

  it("reports a number the register does not know as invalid", async () => {
    const vies = fakeVies({ valid: false, name: "" });
    expect(await checkVatNumber("PL", "0000000000", vies.fetchFn)).toEqual({ status: "invalid", registeredName: null });
  });

  it("never treats an unreachable register as valid", async () => {
    const unverified = { status: "unverified", registeredName: null };
    // The register's own "this country's service is down" answer.
    expect(await checkVatNumber("DE", "000000000", fakeVies({ actionSucceed: false, errorWrappers: [{ error: "MS_UNAVAILABLE" }] }).fetchFn)).toEqual(unverified);
    expect(await checkVatNumber("DE", "000000000", fakeVies({ valid: "true" }).fetchFn)).toEqual(unverified);
    expect(await checkVatNumber("DE", "000000000", fakeVies({}, 503).fetchFn)).toEqual(unverified);
    const down = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await checkVatNumber("DE", "000000000", down)).toEqual(unverified);
    const hangs = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("timed out"))))) as typeof fetch;
    expect(await checkVatNumber("DE", "000000000", hangs, 20)).toEqual(unverified);
  });
});

describe("Scenario 34: how VAT is handled on our invoice", () => {
  it("reverse-charges an EU business with a valid VAT number, and charges VAT without one", () => {
    expect(taxTreatment("PL", "DE", "valid")).toBe("reverse_charge");
    expect(taxTreatment("PL", "DE", "none")).toBe("eu_with_vat");
    expect(taxTreatment("PL", "DE", "invalid")).toBe("eu_with_vat");
    // The register was down: not valid until it says so.
    expect(taxTreatment("PL", "DE", "unverified")).toBe("eu_with_vat");
  });

  it("always charges our own VAT in our own country, and none outside the EU", () => {
    expect(taxTreatment("PL", "PL", "valid")).toBe("domestic");
    expect(taxTreatment("PL", "PL", "none")).toBe("domestic");
    expect(taxTreatment("PL", "OTHER", "none")).toBe("outside_eu");
    expect(taxTreatment("PL", "", "none")).toBe("unknown");
    // The country we invoice from is configuration.
    expect(taxTreatment("NL", "PL", "valid")).toBe("reverse_charge");
    const base = { DATABASE_URL: "x", TOKEN_ENCRYPTION_KEY: "k" };
    expect(loadConfig(base as NodeJS.ProcessEnv).sellerCountry).toBe("PL");
    expect(loadConfig({ ...base, SELLER_COUNTRY: " nl " } as NodeJS.ProcessEnv).sellerCountry).toBe("NL");
  });
});

describe("billing details are stored per customer", () => {
  let db: Db;
  beforeAll(() => {
    db = createDb({ connectionString: inject("databaseUrl"), encryptionKey: Buffer.alloc(32, 7).toString("base64"), max: 2 });
  });
  afterAll(async () => {
    await db.close();
  });
  const newCustomer = async () => {
    const tag = randomBytes(4).toString("hex");
    const { customerId } = await system(db).createCustomerWithUser({ email: `owner.${tag}@nordpart.example`, slug: `nordpart-${tag}` });
    return forCustomer(db, customerId);
  };

  it("keeps the number, the outcome of the check and when it was made", async () => {
    const a = await newCustomer();
    const b = await newCustomer();
    expect(await a.getCustomer()).toMatchObject({ billingCountry: "", vatNumber: "", vatStatus: "none", vatCheckedAt: null });

    const checkedAt = new Date("2026-11-24T09:00:00Z");
    await a.updateBilling({
      billingName: "Nordpart sp. z o.o.", billingAddress: "ul. Przykładowa 1\n40-001 Katowice", billingCountry: "PL",
      vatNumber: "0000000000", vatStatus: "valid", vatCheckedAt: checkedAt, vatRegisteredName: "NORDPART SP. Z O.O.",
    });
    expect(await a.getCustomer()).toMatchObject({
      billingName: "Nordpart sp. z o.o.", billingCountry: "PL", vatNumber: "0000000000", vatStatus: "valid", vatCheckedAt: checkedAt, vatRegisteredName: "NORDPART SP. Z O.O.",
    });
    // Another customer's details are untouched.
    expect(await b.getCustomer()).toMatchObject({ billingCountry: "", vatStatus: "none" });
  });
});
