import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import ExcelJS from "exceljs";
import { createPdfRenderer } from "../apps/worker/src/pdf";

/**
 * Writes the generated files of the invented test companies in fixtures/lipka
 * and fixtures/veld from their JSON definitions:
 *   - price-list.xlsx from price-list.json (the list a customer would upload),
 *   - invoices/*.pdf from invoices.json (real PDFs with real text; a "scan" is a
 *     picture without text).
 * Needs the PDF browser (see README). Run with: pnpm tsx scripts/make-company-fixtures.ts
 * Everything written is invented test data.
 */
const COMPANIES = ["lipka", "veld"];
const root = path.resolve(import.meta.dirname, "../fixtures");

interface InvoiceDocument {
  scan?: boolean;
  language?: string;
  title?: string;
  seller?: string[];
  buyer?: string[];
  meta?: string[];
  lines?: string[][];
  totals?: string[];
}
const WORDS: Record<string, { seller: string; buyer: string; columns: string[] }> = {
  pl: { seller: "Sprzedawca", buyer: "Nabywca", columns: ["Nazwa", "Ilość", "Cena netto", "Wartość netto"] },
  nl: { seller: "Van", buyer: "Aan", columns: ["Omschrijving", "Aantal", "Prijs", "Bedrag"] },
  en: { seller: "Seller", buyer: "Buyer", columns: ["Description", "Quantity", "Unit price", "Amount"] },
};
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const page = (language: string, body: string) => `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm; } body { font: 11pt Arial, "Liberation Sans", sans-serif; color: #111; }
  h1 { font-size: 18pt; } table { width: 100%; border-collapse: collapse; margin-top: 16px; } td, th { border-bottom: 1px solid #ccc; padding: 6px; text-align: left; }
  .cols { display: flex; gap: 40px; } .total { margin-top: 18px; } .total p:last-child { font-size: 14pt; font-weight: bold; }
</style></head><body>${body}</body></html>`;

/** A grey block as a picture, standing in for a scanned page: a PDF with no text in it. */
function scanPng(): string {
  const width = 600;
  const height = 800;
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
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
  header.set([8, 0, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 210)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function invoiceHtml(doc: InvoiceDocument, ownSeller: string[]): string {
  if (doc.scan) return page("en", `<img src="${scanPng()}" style="width:100%">`);
  const language = doc.language ?? "en";
  const w = WORDS[language] ?? WORDS.en!;
  const block = (lines: string[]) => lines.map(escape).join("<br>");
  return page(
    language,
    `<h1>${escape(doc.title ?? "")}</h1>
     <div class="cols"><div><strong>${w.seller}</strong><br>${block(doc.seller ?? ownSeller)}</div><div><strong>${w.buyer}</strong><br>${block(doc.buyer ?? [])}</div></div>
     <p>${block(doc.meta ?? [])}</p>
     <table><tr>${w.columns.map((c) => `<th>${c}</th>`).join("")}</tr>
     ${(doc.lines ?? []).map((line) => `<tr>${line.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("")}</table>
     <div class="total">${(doc.totals ?? []).map((t) => `<p>${escape(t)}</p>`).join("")}</div>`,
  );
}

const pdf = createPdfRenderer();
try {
  for (const slug of COMPANIES) {
    const dir = path.join(root, slug);
    const list = JSON.parse(readFileSync(path.join(dir, "price-list.json"), "utf8")) as { sheetName: string; headers: string[]; rows: (string | number)[][] };
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet(list.sheetName);
    sheet.addRow(list.headers);
    for (const row of list.rows) sheet.addRow(row);
    writeFileSync(path.join(dir, "price-list.xlsx"), Buffer.from(await book.xlsx.writeBuffer()));
    console.log(`${slug}: price-list.xlsx, ${list.rows.length} rows`);

    const invoices = JSON.parse(readFileSync(path.join(dir, "invoices.json"), "utf8")) as {
      seller: { name: string; lines: string[] };
      invoices: { id: string; file: string; document: InvoiceDocument }[];
    };
    mkdirSync(path.join(dir, "invoices"), { recursive: true });
    for (const invoice of invoices.invoices) {
      const bytes = await pdf.render(invoiceHtml(invoice.document, [invoices.seller.name, ...invoices.seller.lines]));
      writeFileSync(path.join(dir, "invoices", invoice.file), bytes);
      console.log(`${slug}: invoices/${invoice.file}, ${bytes.byteLength} bytes`);
    }
  }
} finally {
  await pdf.close();
}
