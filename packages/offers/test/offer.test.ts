import { describe, expect, it } from "vitest";
import {
  buildOffer,
  formatOfferNumber,
  lineTotal,
  matchByCode,
  rankCandidates,
  renderOfferHtml,
  type MatchableItem,
  type OfferDocument,
} from "../src";

const ITEMS: (MatchableItem & { unit: string; netPriceCents: number })[] = [
  { id: "1", code: "PZ-40", name: "Pompa hydrauliczna zębata PZ-40", aliases: ["hydraulic gear pump PZ-40"], unit: "szt.", netPriceCents: 170000 },
  { id: "2", code: "PZ-50", name: "Pompa hydrauliczna zębata PZ-50", aliases: ["hydraulic gear pump PZ-50"], unit: "szt.", netPriceCents: 195800 },
  { id: "3", code: "U-22", name: "Uszczelka gumowa U-22", aliases: ["rubber seal U-22"], unit: "szt.", netPriceCents: 3470 },
  { id: "4", code: "WH-16", name: "Wąż hydrauliczny DN16 2SN", aliases: ["hydraulic hose DN16"], unit: "mb", netPriceCents: 6170 },
  { id: "5", code: "LK-6204", name: "Łożysko kulkowe LK-6204", aliases: ["ball bearing LK-6204"], unit: "szt.", netPriceCents: 2500 },
];

describe("offer arithmetic", () => {
  it("multiplies and rounds in whole numbers", () => {
    expect(lineTotal(12, 170000)).toBe(2040000);
    expect(lineTotal(2.5, 6170)).toBe(15425);
    expect(lineTotal(0.333, 1000)).toBe(333);
    expect(lineTotal(3, 3333)).toBe(9999);
    expect(lineTotal(1.005, 1000)).toBe(1005);
  });

  it("builds lines and totals: net, VAT, gross", () => {
    const { lines, totals } = buildOffer(
      [
        { item: ITEMS[0]!, quantity: 12 },
        { item: ITEMS[3]!, quantity: 2.5 },
      ],
      { discountPercent: 0, vatRate: 23 },
    );
    expect(lines.map((l) => [l.position, l.code, l.quantity, l.unitPriceCents, l.lineTotalCents])).toEqual([
      [1, "PZ-40", 12, 170000, 2040000],
      [2, "WH-16", 2.5, 6170, 15425],
    ]);
    expect(totals).toEqual({
      netCents: 2055425, discountPercent: 0, discountCents: 0, netAfterDiscountCents: 2055425, vatRate: 23, vatCents: 472748, grossCents: 2528173,
    });
  });

  it("takes a discount off the net before VAT", () => {
    const { totals } = buildOffer([{ item: ITEMS[0]!, quantity: 12 }], { discountPercent: 10, vatRate: 23 });
    expect(totals).toMatchObject({ netCents: 2040000, discountCents: 204000, netAfterDiscountCents: 1836000, vatCents: 422280, grossCents: 2258280 });
  });

  it("numbers offers from the customer's pattern", () => {
    expect(formatOfferNumber("OF/{YYYY}/{NNN}", 2026, 7)).toBe("OF/2026/007");
    expect(formatOfferNumber("Q-{NNN}", 2026, 1234)).toBe("Q-1234");
  });
});

describe("finding the item a sender means", () => {
  it("recognises an item code however it is typed, without any model", () => {
    for (const request of ["12 szt. pomp PZ-40", "pompa pz40 x 12", "Pump PZ 40, 12 pcs", "(PZ-40)"]) {
      expect(matchByCode(request, ITEMS), request).toBe(ITEMS[0]);
    }
    expect(matchByCode("łożysko lk-6204", ITEMS)).toBe(ITEMS[4]);
  });

  it("does not match by accident", () => {
    expect(matchByCode("pompa hydrauliczna 40 l/min", ITEMS)).toBeNull();
    expect(matchByCode("PZ-400", ITEMS)).toBeNull(); // not on the list
    expect(matchByCode("40 pieces of U seals", ITEMS)).toBeNull();
    expect(matchByCode("PZ-40 albo PZ-50", ITEMS)).toBe("ambiguous");
  });

  it("shortlists candidates by shared words, numbers first, accents ignored", () => {
    expect(rankCandidates("pompa zebata 40", ITEMS).map((i) => i.code)).toEqual(["PZ-40", "PZ-50"]);
    expect(rankCandidates("hydraulic hose 16 mm", ITEMS)[0]!.code).toBe("WH-16");
    expect(rankCandidates("lozysko kulkowe", ITEMS).map((i) => i.code)).toEqual(["LK-6204"]);
    expect(rankCandidates("silnik elektryczny", ITEMS)).toEqual([]);
  });
});

describe("the offer document", () => {
  const { lines, totals } = buildOffer(
    [
      { item: ITEMS[0]!, quantity: 12 },
      { item: ITEMS[3]!, quantity: 2.5 },
    ],
    { discountPercent: 10, vatRate: 23 },
  );
  const base: OfferDocument = {
    kind: "offer", number: "OF/2026/007", date: "2026-11-24", validUntil: "2026-12-08", language: "pl", layout: "classic",
    brandColor: "#aa3311", logoDataUrl: null, companyName: "Nordpart sp. z o.o.", companyDetails: "Nordpart sp. z o.o.\nul. Przykładowa 1\n40-001 Katowice",
    recipient: ["Anna Kowalczyk", "rolmet.example"], currency: "PLN", lines, totals, paymentTerms: "14 dni", bankDetails: "PL00 0000 0000", footer: "Dziękujemy za zapytanie.",
  };

  it("shows every line and the totals in Polish, with the discount as its own line", () => {
    const html = renderOfferHtml(base);
    expect(html).toContain("Oferta OF/2026/007");
    expect(html).toContain("Pompa hydrauliczna zębata PZ-40");
    expect(html).toContain("1 700,00 PLN"); // unit price
    expect(html).toContain("20 400,00 PLN"); // line total
    expect(html).toContain(">2,5<"); // quantity, Polish decimal comma
    expect(html).toContain("Razem netto");
    expect(html).toContain("Rabat 10%");
    expect(html).toContain("-2 055,43 PLN");
    expect(html).toContain("VAT 23%");
    expect(html).toContain("Do zapłaty");
    expect(html).toContain("Ważna do");
    expect(html).toContain("Warunki płatności");
    expect(html).toContain("#aa3311");
    expect(html).not.toContain("not a VAT invoice");
  });

  it("is in English when the customer chose English, and leaves the discount out when there is none", () => {
    const plain = buildOffer([{ item: ITEMS[0]!, quantity: 1 }], { discountPercent: 0, vatRate: 23 });
    const html = renderOfferHtml({ ...base, ...plain, language: "en", layout: "modern" });
    expect(html).toContain("Offer OF/2026/007");
    expect(html).toContain("1,700.00 PLN");
    expect(html).toContain("Total to pay");
    expect(html).not.toContain("Discount");
    expect(html).toContain('class="layout-modern"');
  });

  it("says an order confirmation is not an invoice", () => {
    const html = renderOfferHtml({ ...base, kind: "order_confirmation", number: "OF/2026/007-C", sourceOfferNumber: "OF/2026/007", validUntil: null, language: "en" });
    expect(html).toContain("Order confirmation OF/2026/007-C");
    expect(html).toContain("For offer OF/2026/007");
    expect(html).toContain("is not a VAT invoice");
    expect(html).not.toContain("Valid until");
  });

  it("treats every value as text, never as markup", () => {
    const html = renderOfferHtml({
      ...base,
      companyName: "<script>alert(1)</script>",
      companyDetails: "",
      recipient: ['<img src=x onerror="alert(2)">'],
      footer: "</div><script>x</script>",
      brandColor: "red; } body { display: none",
      logoDataUrl: "javascript:alert(3)",
      lines: [{ ...lines[0]!, name: "Pump <b>bold</b> & co" }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("display: none");
    expect(html).toContain("Pump &lt;b&gt;bold&lt;/b&gt; &amp; co");
    expect(html).toContain("#1f6f6b"); // fell back to the default colour
  });
});
