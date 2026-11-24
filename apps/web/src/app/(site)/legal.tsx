import type { ReactNode } from "react";

/**
 * Shared pieces of the privacy and terms pages. Both are DRAFTS until the
 * registered business details are filled in and a lawyer has read them:
 * while LEGAL_READY is false every page carries a visible notice and is kept
 * out of search engines.
 */
export const LEGAL_READY = false;

/** The company behind the product. "TODO" parts are shown as visible gaps, never as invented details. */
export const SELLER = {
  name: "Ramon Haagen Consulting",
  country: "Poland",
  address: null as string | null,
  taxNumber: null as string | null,
};

/** A detail that is still to be filled in: shown so it cannot be overlooked. */
export function Gap({ children }: { children: ReactNode }) {
  return <mark className="rounded bg-amber-200 px-1 text-stone-900">[to be completed: {children}]</mark>;
}

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-stone-600">Last changed: {updated}</p>
      {!LEGAL_READY && (
        <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Draft.</strong> This page describes how the product works today. It is not final: the company details
          are still to be completed and the text has not been reviewed by a lawyer.
        </p>
      )}
      <div className="legal mt-8 space-y-4 text-sm leading-relaxed text-stone-800">{children}</div>
    </main>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <h2 className="pt-4 text-lg font-semibold text-stone-900">{children}</h2>;
}

export function SellerLine() {
  return (
    <>
      {SELLER.name}, {SELLER.address ?? <Gap>registered address</Gap>}, {SELLER.country}, tax number{" "}
      {SELLER.taxNumber ?? <Gap>NIP</Gap>}
    </>
  );
}
