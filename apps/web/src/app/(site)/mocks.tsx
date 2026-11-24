import type { ReactNode } from "react";

/**
 * Pictures of the product for the public site, drawn in HTML so they stay sharp
 * and follow the house style. Every company, number and document in them is
 * invented. They show what the product really produces, nothing it does not.
 */

function Window({ title, tag, children }: { title: string; tag?: string; children: ReactNode }) {
  return (
    <figure className="overflow-hidden rounded-2xl border border-stone-200 bg-white text-sm shadow-xl shadow-brand-900/10">
      <figcaption className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-4 py-2.5">
        <span className="flex items-center gap-2 font-medium text-stone-700">
          <span className="flex gap-1.5" aria-hidden="true">
            <i className="h-2.5 w-2.5 rounded-full bg-stone-300" />
            <i className="h-2.5 w-2.5 rounded-full bg-stone-300" />
            <i className="h-2.5 w-2.5 rounded-full bg-stone-300" />
          </span>
          {title}
        </span>
        {tag && <span className="text-xs text-stone-500">{tag}</span>}
      </figcaption>
      <div className="p-4 sm:p-5">{children}</div>
    </figure>
  );
}

const label = "text-[11px] font-semibold uppercase tracking-widest text-stone-500";

/** The 07:30 email. */
export function BriefMock() {
  return (
    <Window title="Your brief for Tuesday" tag="07:30 · example">
      <p className={label}>Needs you today</p>
      <ul className="mt-1.5 space-y-1.5">
        <li>Offer OF/2026/014 for Rolmet is ready in your Drafts.</li>
        <li>Halvorsen Maskin accepted an offer: order confirmation prepared.</li>
      </ul>
      <p className={`${label} mt-4`}>Money due and overdue</p>
      <ul className="mt-1.5 space-y-1.5">
        <li className="flex flex-wrap items-center gap-x-2">
          FV/2026/11/0457 · 26 372,43 PLN
          <span className="rounded-full bg-sun-100 px-2 py-0.5 text-xs font-semibold text-sun-700">7 days overdue</span>
        </li>
        <li className="flex flex-wrap items-center gap-x-2">
          INV-2026-118 · 18 314,70 PLN
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-600">due in 3 days</span>
        </li>
      </ul>
      <p className={`${label} mt-4`}>Went quiet</p>
      <p className="mt-1.5">Stalbud has not answered since last Monday: follow-up in Drafts.</p>
      <p className={`${label} mt-4`}>Filed yesterday</p>
      <p className="mt-1.5">3 documents saved to your OneDrive.</p>
      <p className="mt-4 border-t border-stone-200 pt-3 text-xs text-stone-500">Nothing was sent for you.</p>
    </Window>
  );
}

/** A reply draft with the offer attached, as it waits in the Drafts folder. */
export function OfferMock() {
  return (
    <Window title="Drafts · Re: Quote for 12 pumps" tag="example">
      <p className="text-stone-500">To: anna.kowalczyk@rolmet.example</p>
      <div className="mt-3 space-y-2 text-stone-800">
        <p>Dzień dobry,</p>
        <p>dziękuję za zapytanie. W załączeniu przesyłam ofertę OF/2026/014, ważną do 8 grudnia.</p>
        <p>Pozdrawiam, Tomasz</p>
      </div>
      <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-3">
        <div className="flex items-center gap-2.5">
          <span className="rounded-md bg-brand-600 px-1.5 py-1 text-[10px] font-bold text-white">PDF</span>
          <span className="font-medium">Oferta_OF-2026-014.pdf</span>
        </div>
        <table className="mt-3 w-full text-left text-xs tabular-nums">
          <tbody>
            <tr className="border-t border-stone-200">
              <td className="py-1.5">12 × Pompa hydrauliczna PZ-40</td>
              <td className="py-1.5 text-right">20 400,00</td>
            </tr>
            <tr className="border-t border-stone-200">
              <td className="py-1.5">30 × Uszczelka gumowa U-22</td>
              <td className="py-1.5 text-right">1 041,00</td>
            </tr>
            <tr className="border-t border-stone-300 font-semibold">
              <td className="py-1.5">Total with VAT</td>
              <td className="py-1.5 text-right">26 372,43 PLN</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-stone-500">Prices from your own price list. You press send.</p>
    </Window>
  );
}

/** Open invoices with the reminder that is waiting. */
export function RemindersMock() {
  const rows: [string, string, string, "late" | "soon" | "ok"][] = [
    ["FV/2026/11/0457", "Rolmet", "7 days overdue", "late"],
    ["FV/2026/11/0461", "Stalbud", "14 days overdue", "late"],
    ["INV-2026-118", "Halvorsen Maskin", "due in 3 days", "soon"],
  ];
  const tone = { late: "bg-sun-100 text-sun-700", soon: "bg-stone-100 text-stone-600", ok: "bg-brand-50 text-brand-700" };
  return (
    <Window title="Money due and overdue" tag="example">
      <ul className="divide-y divide-stone-200">
        {rows.map(([number, who, state, kind]) => (
          <li key={number} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span>
              <span className="font-medium">{number}</span> <span className="text-stone-500">· {who}</span>
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone[kind]}`}>{state}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50 p-3">
        <p className="text-xs font-semibold text-brand-800">Reminder ready in Drafts · first, friendly</p>
        <p className="mt-1.5 text-stone-700">
          &ldquo;Dzień dobry, uprzejmie przypominam o fakturze FV/2026/11/0457 na kwotę 26 372,43 PLN z terminem płatności 17
          listopada&hellip;&rdquo;
        </p>
      </div>
    </Window>
  );
}

/** The folder in the customer's own OneDrive. */
export function FilingMock() {
  const Row = ({ depth, name, file }: { depth: number; name: string; file?: boolean }) => (
    <li className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 18 }}>
      <span className={`inline-block h-3.5 w-4 rounded-sm ${file ? "border border-stone-300 bg-white" : "bg-brand-300"}`} aria-hidden="true" />
      <span className={file ? "text-stone-700" : "font-medium"}>{name}</span>
    </li>
  );
  return (
    <Window title="OneDrive · Apps / Adminwise" tag="example">
      <ul>
        <Row depth={0} name="rolmet.example" />
        <Row depth={1} name="2026-11" />
        <Row depth={2} name="2026-11-03_order_ZAM-0457.pdf" file />
        <Row depth={2} name="2026-11-12_invoice_FV-118.pdf" file />
        <Row depth={0} name="stalbud.example" />
        <Row depth={1} name="2026-11" />
        <Row depth={2} name="2026-11-09_contract_umowa-ramowa.pdf" file />
        <Row depth={0} name="Offers" />
        <Row depth={1} name="2026" />
        <Row depth={2} name="Oferta_OF-2026-014.pdf" file />
      </ul>
      <p className="mt-3 border-t border-stone-200 pt-3 text-xs text-stone-500">
        Only this one folder is used. The same file is never saved twice.
      </p>
    </Window>
  );
}
