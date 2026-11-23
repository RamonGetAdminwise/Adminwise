import { formatMoney } from "./money";
import { formatQuantity, type OfferLine, type OfferTotals } from "./offer";
import { en, type OfferStrings } from "./strings/en";
import { pl } from "./strings/pl";

/**
 * The offer and order confirmation as an HTML page, which the worker prints to
 * PDF. Three layouts share one structure; the customer picks one in Settings.
 * Every value shown is passed in: nothing is computed or worded here except
 * the fixed labels in strings/.
 */

const LANGUAGES: Record<string, OfferStrings> = { en, pl };
export function offerStrings(language: string): OfferStrings {
  return LANGUAGES[language] ?? en;
}

export interface OfferDocument {
  kind: "offer" | "order_confirmation";
  number: string;
  /** YYYY-MM-DD */
  date: string;
  validUntil: string | null;
  /** For an order confirmation: the offer it confirms. */
  sourceOfferNumber?: string | null;
  language: string;
  layout: "classic" | "modern" | "compact";
  brandColor: string;
  /** "data:image/png;base64,..." or null: then the company name is shown instead. */
  logoDataUrl: string | null;
  companyName: string;
  companyDetails: string;
  /** Who the offer is for, as lines of text (name, company or address). */
  recipient: string[];
  currency: string;
  lines: OfferLine[];
  totals: OfferTotals;
  paymentTerms: string;
  bankDetails: string;
  footer: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const multiline = (value: string) => escapeHtml(value.trim()).replace(/\r?\n/g, "<br>");
const percent = (value: number, language: string) => formatQuantity(value, language);

function styles(doc: OfferDocument): string {
  // Only a "#rrggbb" value reaches the stylesheet.
  const accent = /^#[0-9a-fA-F]{6}$/.test(doc.brandColor) ? doc.brandColor : "#1f6f6b";
  const compact = doc.layout === "compact";
  const modern = doc.layout === "modern";
  return `
    @page { size: A4; margin: ${compact ? "14mm" : "18mm"}; }
    * { box-sizing: border-box; }
    body { font-family: "Helvetica Neue", Arial, "Liberation Sans", sans-serif; color: #1c1917; font-size: ${compact ? "9pt" : "10.5pt"}; line-height: 1.4; margin: 0; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; ${
      modern ? `background: ${accent}; color: #fff; padding: 18px 20px; border-radius: 6px;` : `border-bottom: 2px solid ${accent}; padding-bottom: 14px;`
    } }
    .logo { max-height: ${compact ? "44px" : "60px"}; max-width: 220px; }
    .company-name { font-size: 16pt; font-weight: 700; }
    .company-details { text-align: right; font-size: 9pt; ${modern ? "" : "color: #44403c;"} }
    .title { margin: ${compact ? "16px" : "26px"} 0 6px; font-size: ${compact ? "15pt" : "19pt"}; font-weight: 700; color: ${accent}; }
    .meta { display: flex; justify-content: space-between; gap: 24px; margin-bottom: ${compact ? "12px" : "20px"}; }
    .meta dl { margin: 0; display: grid; grid-template-columns: auto auto; column-gap: 12px; row-gap: 2px; }
    .meta dt { color: #78716c; } .meta dd { margin: 0; font-weight: 600; }
    .label { color: #78716c; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; }
    table.lines { width: 100%; border-collapse: collapse; }
    table.lines th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; padding: ${compact ? "4px 6px" : "7px 8px"}; ${
      modern ? `color: ${accent}; border-bottom: 2px solid ${accent};` : `background: #f5f5f4; border-bottom: 1px solid #a8a29e;`
    } }
    table.lines td { padding: ${compact ? "3px 6px" : "7px 8px"}; border-bottom: 1px solid #e7e5e4; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; }
    table.lines tr { page-break-inside: avoid; }
    table.totals { margin: ${compact ? "10px" : "16px"} 0 0 auto; border-collapse: collapse; min-width: 46%; page-break-inside: avoid; }
    table.totals td { padding: 4px 8px; }
    table.totals tr.grand td { font-weight: 700; font-size: 12pt; border-top: 2px solid ${accent}; padding-top: 8px; }
    .notes { margin-top: ${compact ? "14px" : "26px"}; display: flex; gap: 32px; page-break-inside: avoid; }
    .notes > div { flex: 1; }
    .footer { margin-top: ${compact ? "14px" : "28px"}; padding-top: 10px; border-top: 1px solid #d6d3d1; font-size: 8.5pt; color: #57534e; }
  `;
}

export function renderOfferHtml(doc: OfferDocument): string {
  const t = offerStrings(doc.language);
  const money = (cents: number) => escapeHtml(formatMoney(cents, doc.currency, doc.language));
  const title = doc.kind === "offer" ? t.offer : t.orderConfirmation;
  const hasCodes = doc.lines.some((line) => line.code);

  const rows = doc.lines
    .map(
      (line) => `
      <tr>
        <td>${line.position}</td>
        ${hasCodes ? `<td>${escapeHtml(line.code)}</td>` : ""}
        <td>${escapeHtml(line.name)}</td>
        <td class="num">${escapeHtml(formatQuantity(line.quantity, doc.language))}</td>
        <td>${escapeHtml(line.unit)}</td>
        <td class="num">${money(line.unitPriceCents)}</td>
        <td class="num">${money(line.lineTotalCents)}</td>
      </tr>`,
    )
    .join("");

  const totals = [
    `<tr><td>${t.netTotal}</td><td class="num">${money(doc.totals.netCents)}</td></tr>`,
    // A discount is always its own line here, never a sentence in the email.
    ...(doc.totals.discountCents > 0
      ? [
          `<tr class="discount"><td>${escapeHtml(t.discount(percent(doc.totals.discountPercent, doc.language)))}</td><td class="num">-${money(doc.totals.discountCents)}</td></tr>`,
          `<tr><td>${t.netAfterDiscount}</td><td class="num">${money(doc.totals.netAfterDiscountCents)}</td></tr>`,
        ]
      : []),
    `<tr><td>${escapeHtml(t.vat(percent(doc.totals.vatRate, doc.language)))}</td><td class="num">${money(doc.totals.vatCents)}</td></tr>`,
    `<tr class="grand"><td>${t.grossTotal}</td><td class="num">${money(doc.totals.grossCents)}</td></tr>`,
  ].join("");

  const notes = [
    doc.paymentTerms.trim() ? `<div><div class="label">${t.paymentTerms}</div>${multiline(doc.paymentTerms)}</div>` : "",
    doc.bankDetails.trim() ? `<div><div class="label">${t.bankDetails}</div>${multiline(doc.bankDetails)}</div>` : "",
  ].join("");

  return `<!doctype html>
<html lang="${escapeHtml(doc.language)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(`${title} ${doc.number}`)}</title>
<style>${styles(doc)}</style>
</head>
<body class="layout-${doc.layout}">
  <div class="head">
    <div>${
      doc.logoDataUrl && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(doc.logoDataUrl)
        ? `<img class="logo" alt="" src="${doc.logoDataUrl}">`
        : `<div class="company-name">${escapeHtml(doc.companyName)}</div>`
    }</div>
    <div class="company-details">${multiline(doc.companyDetails || doc.companyName)}</div>
  </div>

  <div class="title">${title} ${escapeHtml(doc.number)}</div>
  <div class="meta">
    <div>
      <div class="label">${t.preparedFor}</div>
      <div class="recipient">${doc.recipient.map(escapeHtml).join("<br>")}</div>
    </div>
    <dl>
      <dt>${t.date}</dt><dd>${escapeHtml(doc.date)}</dd>
      ${doc.validUntil ? `<dt>${t.validUntil}</dt><dd>${escapeHtml(doc.validUntil)}</dd>` : ""}
      ${doc.sourceOfferNumber ? `<dt></dt><dd>${escapeHtml(t.forOffer(doc.sourceOfferNumber))}</dd>` : ""}
    </dl>
  </div>

  <table class="lines">
    <thead>
      <tr>
        <th>${t.position}</th>
        ${hasCodes ? `<th>${t.code}</th>` : ""}
        <th>${t.item}</th>
        <th class="num">${t.quantity}</th>
        <th>${t.unit}</th>
        <th class="num">${t.unitPrice}</th>
        <th class="num">${t.lineTotal}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <table class="totals"><tbody>${totals}</tbody></table>

  ${notes ? `<div class="notes">${notes}</div>` : ""}
  <div class="footer">
    ${doc.kind === "order_confirmation" ? `<div class="not-invoice">${t.notAnInvoice}</div>` : `<div>${t.pricesNet}</div>`}
    ${doc.footer.trim() ? `<div>${multiline(doc.footer)}</div>` : ""}
  </div>
</body>
</html>`;
}
