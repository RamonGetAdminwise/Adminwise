import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { createPdfRenderer } from "../apps/worker/src/pdf";

/**
 * Writes the invoice fixtures for Nordpart (invented company, invented buyers)
 * as real PDF files in fixtures/nordpart/invoices/, with invoices.json saying
 * what a correct reading finds. Needs the PDF browser (see README).
 * Run with: pnpm tsx scripts/make-invoice-fixtures.ts
 */
const dir = path.resolve(import.meta.dirname, "../fixtures/nordpart/invoices");
mkdirSync(dir, { recursive: true });

const page = (body: string) => `<!doctype html><html lang="pl"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm; } body { font: 11pt Arial, "Liberation Sans", sans-serif; color: #111; }
  h1 { font-size: 18pt; } table { width: 100%; border-collapse: collapse; margin-top: 16px; } td, th { border-bottom: 1px solid #ccc; padding: 6px; text-align: left; }
  .cols { display: flex; gap: 40px; } .total { font-size: 14pt; font-weight: bold; margin-top: 18px; }
</style></head><body>${body}</body></html>`;

const NORDPART = "Nordpart sp. z o.o.<br>ul. Przykładowa 1, 40-001 Katowice<br>NIP 0000000000";

/** A grey block as a picture, standing in for a scanned page: a PDF with no text in it. */
function scanPng(): string {
  const width = 600;
  const height = 800;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 210)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const invoices = [
  {
    id: "i01",
    file: "FV_2026_11_0457.pdf",
    note: "scenario 17: Nordpart's invoice with a printed due date",
    html: page(`<h1>Faktura VAT nr FV/2026/11/0457</h1>
      <div class="cols"><div><b>Sprzedawca</b><br>${NORDPART}</div><div><b>Nabywca</b><br>Rolmet sp. z o.o.<br>ul. Fabryczna 12, 41-200 Sosnowiec<br>NIP 1111111111</div></div>
      <p>Data wystawienia: 2026-11-03<br>Data sprzedaży: 2026-11-03<br>Termin płatności: 2026-11-17<br>Sposób płatności: przelew</p>
      <table><tr><th>Nazwa</th><th>Ilość</th><th>Cena netto</th><th>Wartość netto</th></tr>
      <tr><td>Pompa hydrauliczna zębata PZ-40</td><td>12 szt.</td><td>1 700,00</td><td>20 400,00</td></tr>
      <tr><td>Uszczelka gumowa U-22</td><td>30 szt.</td><td>34,70</td><td>1 041,00</td></tr></table>
      <p>Razem netto: 21 441,00 PLN<br>VAT 23%: 4 931,43 PLN</p><p class="total">Do zapłaty: 26 372,43 PLN</p>`),
    expected: { status: "open", number: "FV/2026/11/0457", amountCents: 2637243, currency: "PLN", issueDate: "2026-11-03", dueDate: "2026-11-17", buyer: "Rolmet sp. z o.o." },
    recorded: { is_invoice: "yes", issued_by_company: "yes", number: "FV/2026/11/0457", gross_amount: "26 372,43", currency: "PLN", issue_date: "2026-11-03", due_date: "2026-11-17", payment_term_days: null, buyer: "Rolmet sp. z o.o." },
  },
  {
    id: "i02",
    file: "Invoice_2026-118.pdf",
    note: "an English invoice with only a payment term in days: the due date is counted by code",
    html: page(`<h1>Invoice No. INV-2026-118</h1>
      <div class="cols"><div><b>Seller</b><br>${NORDPART}</div><div><b>Buyer</b><br>Halvorsen Maskin AS<br>Industriveien 4, 0581 Oslo</div></div>
      <p>Invoice date: 03.11.2026<br>Payment terms: 14 days net</p>
      <table><tr><th>Item</th><th>Qty</th><th>Net</th></tr><tr><td>Gear motor GM-75</td><td>4 pcs</td><td>14,890.00</td></tr></table>
      <p>VAT 23%: 3,424.70 PLN</p><p class="total">Total due: 18,314.70 PLN</p>`),
    expected: { status: "open", number: "INV-2026-118", amountCents: 1831470, currency: "PLN", issueDate: "2026-11-03", dueDate: "2026-11-17", buyer: "Halvorsen Maskin AS" },
    recorded: { is_invoice: "yes", issued_by_company: "yes", number: "INV-2026-118", gross_amount: "18,314.70", currency: "PLN", issue_date: "2026-11-03", due_date: null, payment_term_days: 14, buyer: "Halvorsen Maskin AS" },
  },
  {
    id: "i03",
    file: "FV_2026_11_0461.pdf",
    note: "scenario 20: no due date and no payment term printed; the model wrongly offers one and it is dropped",
    html: page(`<h1>Faktura VAT nr FV/2026/11/0461</h1>
      <div class="cols"><div><b>Sprzedawca</b><br>${NORDPART}</div><div><b>Nabywca</b><br>Stalbud S.A.<br>ul. Hutnicza 3, 40-241 Katowice</div></div>
      <p>Data wystawienia: 2026-11-05</p>
      <table><tr><th>Nazwa</th><th>Ilość</th><th>Wartość netto</th></tr><tr><td>Łożysko kulkowe LK-6203</td><td>20 szt.</td><td>6 851,60</td></tr></table>
      <p class="total">Do zapłaty: 8 427,47 PLN</p>`),
    expected: { status: "needs_due_date", number: "FV/2026/11/0461", amountCents: 842747, currency: "PLN", issueDate: "2026-11-05", dueDate: null, buyer: "Stalbud S.A." },
    recorded: { is_invoice: "yes", issued_by_company: "yes", number: "FV/2026/11/0461", gross_amount: "8 427,47", currency: "PLN", issue_date: "2026-11-05", due_date: "2026-11-19", payment_term_days: null, buyer: "Stalbud S.A." },
  },
  {
    id: "i04",
    file: "Faktura_transport_7781.pdf",
    note: "an invoice a supplier sent TO Nordpart: not ours to chase",
    html: page(`<h1>Faktura VAT nr T/7781/2026</h1>
      <div class="cols"><div><b>Sprzedawca</b><br>Kurier Północ sp. z o.o.<br>ul. Portowa 9, 80-001 Gdańsk</div><div><b>Nabywca</b><br>${NORDPART}</div></div>
      <p>Data wystawienia: 2026-11-04<br>Termin płatności: 2026-11-18</p><p class="total">Do zapłaty: 615,00 PLN</p>`),
    expected: { status: "not_ours" },
    recorded: { is_invoice: "yes", issued_by_company: "no", number: "T/7781/2026", gross_amount: "615,00", currency: "PLN", issue_date: "2026-11-04", due_date: "2026-11-18", payment_term_days: null, buyer: "Nordpart sp. z o.o." },
  },
  {
    id: "i05",
    file: "skan_faktury.pdf",
    note: "a scan: a picture of a page with no text in it",
    html: page(`<img src="${scanPng()}" style="width:100%">`),
    expected: { status: "unreadable" },
    recorded: null,
  },
];

const pdf = createPdfRenderer();
try {
  for (const invoice of invoices) {
    writeFileSync(path.join(dir, invoice.file), await pdf.render(invoice.html));
    console.log(`wrote ${invoice.file}`);
  }
} finally {
  await pdf.close();
}
writeFileSync(
  path.join(dir, "invoices.json"),
  JSON.stringify(
    {
      _comment: "What a correct reading of each PDF in this folder gives, and the answer the recorded model returns for it ('recorded'; i03's due date is deliberately one that is not printed on the invoice). Generated by scripts/make-invoice-fixtures.ts.",
      invoices: invoices.map((invoice) => ({ id: invoice.id, file: invoice.file, note: invoice.note, expected: invoice.expected, recorded: invoice.recorded })),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote invoices.json");
