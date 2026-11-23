import { forCustomer, type PriceList } from "@adminwise/db";
import { formatMoney } from "@adminwise/offers";
import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { getConfig, getDb } from "@/lib/server";
import {
  addDiscount,
  confirmPriceList,
  discardOfferProposal,
  discardPriceList,
  remapPriceListColumns,
  removeDiscount,
  removeLogo,
  saveOfferSettings,
  uploadLogo,
  uploadPriceList,
  uploadSampleOffer,
  useOfferProposal,
} from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  choice: "Choose a language and a layout from the lists.",
  currency: "The currency is a three-letter code, for example PLN or EUR.",
  vat: "The VAT rate is a number from 0 to 100.",
  valid: "Offer validity is a whole number of days from 1 to 365.",
  number: "The offer number pattern must contain {NNN} and may use letters, digits, / - _ . and {YYYY}.",
  color: "Choose a colour.",
  logo: "The logo must be a PNG or JPEG picture of at most 500 KB.",
  file: "Choose an Excel file (.xlsx) of at most 5 MB.",
  unreadable: "This file could not be read as a price list. Save it as an Excel workbook (.xlsx) with one row of column titles and try again.",
  columns: "Those columns do not fit the sheet. The name and the price must be two different columns.",
  empty: "There are no readable items yet, so the list cannot be used. Choose the right columns first.",
  sample: "Choose a PDF of at most 5 MB.",
  sample_unreadable: "This PDF holds no text we can read (a scan or a photo?). Type your details below instead.",
  sample_nothing_found: "No company details were found in this document. Type them below instead.",
  sample_failed: "The document could not be read right now. Nothing was stored; please try again.",
  discount: "Enter a domain (rolmet.example) or one email address, and a percentage above 0 and up to 100.",
};
const SAVED: Record<string, string> = {
  settings: "Offer details saved.",
  logo: "Logo saved.",
  logo_removed: "Logo removed.",
  uploaded: "File read. Check the preview below and confirm.",
  remapped: "Columns changed. Check the preview again.",
  activated: "Price list confirmed. New offers use it from now on.",
  discarded: "Upload discarded.",
  sample: "Document read. Check what was found below, then use it or discard it.",
  proposal_used: "Offer details filled in from your document. Check them below.",
  proposal_discarded: "Discarded. Nothing was changed.",
  discount: "Discount saved.",
  discount_removed: "Discount removed.",
};
const SKIP_REASONS: Record<string, string> = {
  no_name: "no item name",
  price_not_readable: "the price is not a clear number",
  duplicate_code: "this item code appears earlier in the list",
};
const LAYOUTS: Record<string, string> = {
  classic: "Classic: logo left, details right, lined table",
  modern: "Modern: coloured header band, open table",
  compact: "Compact: small type, fits long offers on fewer pages",
};
const COLUMN_FIELDS: { key: "name" | "price" | "code" | "unit" | "aliases"; label: string; required: boolean }[] = [
  { key: "name", label: "Item name", required: true },
  { key: "price", label: "Net price", required: true },
  { key: "code", label: "Item code", required: false },
  { key: "unit", label: "Unit", required: false },
  { key: "aliases", label: "Other names", required: false },
];

function Notice({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  const colours = tone === "ok" ? "border-teal-200 bg-teal-50 text-teal-900" : "border-red-200 bg-red-50 text-red-900";
  return <p className={`mb-6 rounded-md border px-4 py-3 text-sm ${colours}`}>{children}</p>;
}

function mappingSource(list: PriceList): string {
  if (!list.mapping) return "We could not tell which column is which. Choose them below.";
  if (list.mapping.source === "customer") return "You chose the columns.";
  return "We worked out the columns from your file. Change them below if one is wrong.";
}

export default async function OfferSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const config = getConfig();
  const scope = forCustomer(getDb(), session.customerId);
  const [customer, active, draft, discounts, logo] = await Promise.all([
    scope.getCustomer(),
    scope.getPriceListByStatus("active"),
    scope.getPriceListByStatus("draft"),
    scope.listDiscounts(),
    scope.getLogo(),
  ]);
  const proposal = customer.offerProposal;
  const preview = draft ? await scope.listPriceItems(draft.id, 10) : [];
  const exampleNumber = customer.offerNumberPattern
    .replace("{YYYY}", String(new Date().getFullYear()))
    .replace("{NNN}", "001");

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm">
          <a className="underline" href="/settings">
            &larr; Settings
          </a>
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Offers and price list</h1>
        <p className="text-sm text-stone-600">
          {config.appName} prepares offers from your price list. Every price in an offer comes from the list you confirm
          here; nothing is ever estimated.
        </p>
      </header>

      {params.saved && SAVED[params.saved] && <Notice tone="ok">{SAVED[params.saved]}</Notice>}
      {params.error && ERRORS[params.error] && <Notice tone="error">{ERRORS[params.error]}</Notice>}

      <section className="card" id="price-list">
        <h2 className="text-lg font-semibold">Price list</h2>
        {active ? (
          <p className="mt-2 text-sm">
            <span className="mr-2 inline-block h-2 w-2 rounded-full bg-green-600" />
            In use: <strong>{active.fileName}</strong>, {active.itemCount} items, prices in {active.currency}, confirmed{" "}
            {active.activatedAt?.toISOString().slice(0, 10)}.
          </p>
        ) : (
          <p className="mt-2 text-sm text-stone-600">No price list yet. Without one, no offers are prepared.</p>
        )}

        {draft && (
          <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
            <p className="font-medium">Waiting for your confirmation: {draft.fileName}</p>
            <p className="mt-1">
              {draft.itemCount} items read from sheet &quot;{draft.raw?.sheetName}&quot;, prices in {draft.currency}.{" "}
              {mappingSource(draft)}
            </p>

            {preview.length > 0 && (
              <table className="mt-3 w-full text-left">
                <thead className="text-stone-600">
                  <tr>
                    <th className="py-1 font-medium">Code</th>
                    <th className="py-1 font-medium">Name</th>
                    <th className="py-1 font-medium">Unit</th>
                    <th className="py-1 text-right font-medium">Net price</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((item) => (
                    <tr key={item.id} className="border-t border-amber-200">
                      <td className="py-1">{item.code}</td>
                      <td className="py-1">{item.name}</td>
                      <td className="py-1">{item.unit}</td>
                      <td className="py-1 text-right">{formatMoney(item.netPriceCents, draft.currency, "en")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {draft.itemCount > preview.length && (
              <p className="mt-1 text-stone-600">...and {draft.itemCount - preview.length} more.</p>
            )}

            {draft.skipped.length > 0 && (
              <div className="mt-3">
                <p className="font-medium">{draft.skipped.length} row(s) were left out</p>
                <ul className="mt-1 list-disc pl-5">
                  {draft.skipped.slice(0, 20).map((s) => (
                    <li key={s.row}>
                      Row {s.row}: {SKIP_REASONS[s.reason] ?? s.reason}
                    </li>
                  ))}
                </ul>
                <p className="hint">Fix these rows in your file and upload it again, or confirm without them.</p>
              </div>
            )}

            {draft.raw && (
              <form action={remapPriceListColumns} className="mt-4 grid gap-3 sm:grid-cols-5">
                {COLUMN_FIELDS.map((field) => (
                  <div key={field.key}>
                    <label htmlFor={`col-${field.key}`}>{field.label}</label>
                    <select
                      id={`col-${field.key}`}
                      name={field.key}
                      defaultValue={draft.mapping?.[field.key] ?? "none"}
                    >
                      <option value="none">{field.required ? "Choose..." : "(none)"}</option>
                      {draft.raw!.headers.map((header, index) => (
                        <option key={index} value={index}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <div className="sm:col-span-5">
                  <button className="btn-secondary" type="submit">
                    Read again with these columns
                  </button>
                </div>
              </form>
            )}

            <div className="mt-4 flex gap-3">
              <form action={confirmPriceList}>
                <button className="btn" type="submit" disabled={draft.itemCount === 0}>
                  Confirm and use this price list
                </button>
              </form>
              <form action={discardPriceList}>
                <button className="btn-secondary" type="submit">
                  Discard
                </button>
              </form>
            </div>
          </div>
        )}

        <form action={uploadPriceList} className="mt-5 space-y-3">
          <div>
            <label htmlFor="priceList">{active ? "Upload a new version" : "Upload your price list"}</label>
            <input id="priceList" name="priceList" type="file" accept=".xlsx" required />
            <p className="hint">
              Your own Excel file (.xlsx) as it is: one row of column titles, one item per row. We find the columns for
              the item name and the net price (and code, unit, other names if they are there) and show you a preview.
              Prices are read in {customer.currency}; change the currency under Offer details first if that is wrong.
              Offers already made keep their prices when you upload a new list.
            </p>
          </div>
          <button className="btn" type="submit">
            Upload and preview
          </button>
        </form>
      </section>

      <section className="card" id="details">
        <h2 className="text-lg font-semibold">Offer details</h2>

        {proposal && (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
            <p className="font-medium">Read from your document: check before using</p>
            <p className="mt-1">
              Only what is printed on the document is shown. Make sure these are <strong>your</strong> details and not
              your customer&apos;s.
            </p>
            <dl className="mt-3 space-y-2">
              {(
                [
                  ["Company details", proposal.companyDetails],
                  ["Bank details", proposal.bankDetails],
                  ["Payment terms", proposal.paymentTerms],
                  ["Currency", proposal.currency],
                  ["VAT rate", proposal.vatRate === null ? null : `${proposal.vatRate}%`],
                  ["Offer language", proposal.offerLanguage === null ? null : proposal.offerLanguage === "pl" ? "Polish" : "English"],
                ] as const
              )
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label}>
                    <dt className="font-medium">{label}</dt>
                    <dd className="whitespace-pre-line">{value}</dd>
                  </div>
                ))}
            </dl>
            <div className="mt-4 flex gap-3">
              <form action={useOfferProposal}>
                <button className="btn" type="submit">
                  Use these
                </button>
              </form>
              <form action={discardOfferProposal}>
                <button className="btn-secondary" type="submit">
                  Discard
                </button>
              </form>
            </div>
            <p className="hint">Using them replaces the matching fields below. Anything not found stays as it is.</p>
          </div>
        )}

        <form action={uploadSampleOffer} className="mt-4 space-y-2 border-b border-stone-200 pb-5">
          <label htmlFor="sample">Fill in from a past offer or invoice (PDF)</label>
          <input id="sample" name="sample" type="file" accept="application/pdf,.pdf" required />
          <button className="btn-secondary" type="submit">
            Read my details from this file
          </button>
          <p className="hint">
            We read your company details, bank details, payment terms, currency and VAT rate from one of your own
            documents and show them to you first. The file is not stored. Scans and photos cannot be read.
          </p>
        </form>
        <form action={saveOfferSettings} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="offerLanguage">Language of the offer document</label>
              <select id="offerLanguage" name="offerLanguage" defaultValue={customer.offerLanguage}>
                <option value="en">English</option>
                <option value="pl">Polish</option>
              </select>
              <p className="hint">The document&apos;s own words (Offer, Quantity, Total). The email with it is written in the sender&apos;s language.</p>
            </div>
            <div>
              <label htmlFor="offerLayout">Layout</label>
              <select id="offerLayout" name="offerLayout" defaultValue={customer.offerLayout}>
                {Object.entries(LAYOUTS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="currency">Currency</label>
              <input id="currency" name="currency" type="text" maxLength={3} defaultValue={customer.currency} required />
              <p className="hint">Three letters: PLN, EUR, USD. Price list prices are net amounts in this currency.</p>
            </div>
            <div>
              <label htmlFor="vatRate">VAT rate (%)</label>
              <input id="vatRate" name="vatRate" type="text" inputMode="decimal" defaultValue={customer.vatRate} required />
              <p className="hint">Added to the net total on every offer.</p>
            </div>
            <div>
              <label htmlFor="offerValidDays">Offers are valid for (days)</label>
              <input id="offerValidDays" name="offerValidDays" type="number" min={1} max={365} defaultValue={customer.offerValidDays} required />
            </div>
            <div>
              <label htmlFor="offerNumberPattern">Offer number pattern</label>
              <input id="offerNumberPattern" name="offerNumberPattern" type="text" defaultValue={customer.offerNumberPattern} required />
              <p className="hint">
                {"{YYYY}"} is the year, {"{NNN}"} a counter that restarts each year. Next offer would look like: {exampleNumber}
              </p>
            </div>
            <div>
              <label htmlFor="brandColor">Accent colour</label>
              <input id="brandColor" name="brandColor" type="color" defaultValue={customer.brandColor} />
            </div>
          </div>
          <div>
            <label htmlFor="paymentTerms">Payment terms</label>
            <input id="paymentTerms" name="paymentTerms" type="text" defaultValue={customer.paymentTerms} placeholder="14 days from invoice date" />
          </div>
          <div>
            <label htmlFor="companyDetails">Your company details</label>
            <textarea id="companyDetails" name="companyDetails" rows={4} defaultValue={customer.companyDetails} placeholder={"Company name\nStreet and number\nPostcode and city\nTax number"} />
            <p className="hint">Printed at the top of every offer, exactly as written here.</p>
          </div>
          <div>
            <label htmlFor="bankDetails">Bank details</label>
            <textarea id="bankDetails" name="bankDetails" rows={2} defaultValue={customer.bankDetails} />
          </div>
          <div>
            <label htmlFor="offerFooter">Footer text</label>
            <textarea id="offerFooter" name="offerFooter" rows={2} defaultValue={customer.offerFooter} />
          </div>
          <button className="btn" type="submit">
            Save
          </button>
        </form>

        <div className="mt-6 border-t border-stone-200 pt-5 text-sm">
          <p className="font-medium">Logo</p>
          {logo ? (
            <div className="mt-2 flex items-center gap-4">
              {/* The customer's own picture, read back from their settings. */}
              <img alt="Your logo" className="max-h-16" src={`data:${logo.contentType};base64,${Buffer.from(logo.content).toString("base64")}`} />
              <form action={removeLogo}>
                <button className="btn-secondary" type="submit">
                  Remove
                </button>
              </form>
            </div>
          ) : (
            <p className="mt-1 text-stone-600">No logo yet: offers show your company name instead.</p>
          )}
          <form action={uploadLogo} className="mt-3 flex items-end gap-3">
            <div>
              <label htmlFor="logo">{logo ? "Replace logo" : "Upload logo"}</label>
              <input id="logo" name="logo" type="file" accept="image/png,image/jpeg" required />
            </div>
            <button className="btn-secondary" type="submit">
              Upload
            </button>
          </form>
          <p className="hint">PNG or JPEG, at most 500 KB.</p>
        </div>
      </section>

      <section className="card" id="discounts">
        <h2 className="text-lg font-semibold">Discounts per sender</h2>
        <p className="mt-1 text-sm text-stone-600">
          A fixed discount for a company or one person. It appears as its own line in the totals of their offers.
        </p>
        {discounts.length > 0 && (
          <table className="mt-3 w-full text-left text-sm">
            <tbody>
              {discounts.map((discount) => (
                <tr key={discount.id} className="border-t border-stone-100">
                  <td className="py-2">{discount.match}</td>
                  <td className="py-2">{discount.percent} %</td>
                  <td className="py-2 text-right">
                    <form action={removeDiscount}>
                      <input type="hidden" name="id" value={discount.id} />
                      <button className="btn-secondary" type="submit">
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form action={addDiscount} className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="match">Company domain or email address</label>
            <input id="match" name="match" type="text" placeholder="rolmet.example" required />
          </div>
          <div>
            <label htmlFor="percent">Discount (%)</label>
            <input id="percent" name="percent" type="text" inputMode="decimal" placeholder="10" required />
          </div>
          <button className="btn" type="submit">
            Add
          </button>
        </form>
        <p className="hint">A rule for one address wins over a rule for that person&apos;s company.</p>
      </section>
    </div>
  );
}
