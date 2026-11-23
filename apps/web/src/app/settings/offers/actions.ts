"use server";

import { forCustomer, OFFER_LANGUAGES, OFFER_LAYOUTS, type OfferLanguage, type OfferLayout } from "@adminwise/db";
import { importPriceList, MAX_PRICE_LIST_BYTES, PriceListError, remapPriceList } from "@adminwise/offers";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getAi, getDb } from "@/lib/server";

const PAGE = "/settings/offers";
const MAX_LOGO_BYTES = 500 * 1024;

const text = (value: FormDataEntryValue | null, max: number) =>
  (typeof value === "string" ? value : "").trim().slice(0, max);

async function session() {
  const current = await requireSession();
  return { ...current, scope: forCustomer(getDb(), current.customerId) };
}

export async function saveOfferSettings(formData: FormData) {
  const { scope, userId } = await session();
  const offerLanguage = text(formData.get("offerLanguage"), 2) as OfferLanguage;
  const offerLayout = text(formData.get("offerLayout"), 20) as OfferLayout;
  const currency = text(formData.get("currency"), 3).toUpperCase();
  const vatRate = Number(text(formData.get("vatRate"), 6).replace(",", "."));
  const offerValidDays = Number(text(formData.get("offerValidDays"), 3));
  const offerNumberPattern = text(formData.get("offerNumberPattern"), 40);
  const brandColor = text(formData.get("brandColor"), 7);

  if (!OFFER_LANGUAGES.includes(offerLanguage) || !OFFER_LAYOUTS.includes(offerLayout)) redirect(`${PAGE}?error=choice`);
  if (!/^[A-Z]{3}$/.test(currency)) redirect(`${PAGE}?error=currency`);
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) redirect(`${PAGE}?error=vat`);
  if (!Number.isInteger(offerValidDays) || offerValidDays < 1 || offerValidDays > 365) redirect(`${PAGE}?error=valid`);
  // The counter must be in the pattern, or two offers would get the same number.
  if (!/^[A-Za-z0-9/_\-. {}]+$/.test(offerNumberPattern) || !offerNumberPattern.includes("{NNN}")) redirect(`${PAGE}?error=number`);
  if (!/^#[0-9a-fA-F]{6}$/.test(brandColor)) redirect(`${PAGE}?error=color`);

  await scope.updateOfferSettings({
    offerLanguage,
    offerLayout,
    currency,
    vatRate: Math.round(vatRate * 100) / 100,
    paymentTerms: text(formData.get("paymentTerms"), 300),
    offerValidDays,
    offerNumberPattern,
    companyDetails: text(formData.get("companyDetails"), 1000),
    bankDetails: text(formData.get("bankDetails"), 500),
    offerFooter: text(formData.get("offerFooter"), 500),
    brandColor,
  });
  await scope.audit("offer_settings.updated", { offerLanguage, offerLayout, currency }, userId);
  redirect(`${PAGE}?saved=settings`);
}

export async function uploadLogo(formData: FormData) {
  const { scope, userId } = await session();
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) redirect(`${PAGE}?error=logo`);
  // Pictures only, and only formats that cannot carry scripts into the offer document.
  if (!["image/png", "image/jpeg"].includes(file.type) || file.size > MAX_LOGO_BYTES) redirect(`${PAGE}?error=logo`);
  await scope.setLogo(new Uint8Array(await file.arrayBuffer()), file.type);
  await scope.audit("logo.uploaded", { bytes: file.size }, userId);
  redirect(`${PAGE}?saved=logo`);
}

export async function removeLogo() {
  const { scope, userId } = await session();
  await scope.removeLogo();
  await scope.audit("logo.removed", {}, userId);
  redirect(`${PAGE}?saved=logo_removed`);
}

/** The customer's own Excel file: read it, propose the columns, show a preview. Nothing is used until they confirm. */
export async function uploadPriceList(formData: FormData) {
  const { scope, userId } = await session();
  const file = formData.get("priceList");
  if (!(file instanceof File) || file.size === 0) redirect(`${PAGE}?error=file#price-list`);
  if (file.size > MAX_PRICE_LIST_BYTES || !/\.xlsx$/i.test(file.name)) redirect(`${PAGE}?error=file#price-list`);

  const customer = await scope.getCustomer();
  let failed = false;
  try {
    const summary = await importPriceList(scope, getAi(), {
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      currency: customer.currency,
    });
    await scope.audit("price_list.uploaded", { items: summary.itemCount, skipped: summary.skippedCount }, userId);
  } catch (error) {
    if (!(error instanceof PriceListError)) throw error;
    failed = true;
  }
  redirect(failed ? `${PAGE}?error=unreadable#price-list` : `${PAGE}?saved=uploaded#price-list`);
}

/** The customer corrected which column holds what. */
export async function remapPriceListColumns(formData: FormData) {
  const { scope } = await session();
  const column = (name: string, required: boolean): number | null => {
    const value = text(formData.get(name), 4);
    if (value === "" || value === "none") return required ? -1 : null;
    return Number.isInteger(Number(value)) ? Number(value) : -1;
  };
  const ok = await remapPriceList(scope, {
    name: column("name", true) ?? -1,
    price: column("price", true) ?? -1,
    code: column("code", false),
    unit: column("unit", false),
    aliases: column("aliases", false),
  });
  redirect(ok ? `${PAGE}?saved=remapped#price-list` : `${PAGE}?error=columns#price-list`);
}

export async function confirmPriceList() {
  const { scope, userId } = await session();
  const draft = await scope.getPriceListByStatus("draft");
  const ok = draft ? await scope.activatePriceList(draft.id) : false;
  if (ok) await scope.audit("price_list.activated", { items: draft!.itemCount }, userId);
  redirect(ok ? `${PAGE}?saved=activated#price-list` : `${PAGE}?error=empty#price-list`);
}

export async function discardPriceList() {
  const { scope } = await session();
  await scope.discardPriceListDraft();
  redirect(`${PAGE}?saved=discarded#price-list`);
}

export async function addDiscount(formData: FormData) {
  const { scope, userId } = await session();
  const match = text(formData.get("match"), 200).toLowerCase().replace(/^@/, "");
  const percent = Number(text(formData.get("percent"), 6).replace(",", "."));
  // A domain ("rolmet.example") or one address.
  const validMatch = /^([a-z0-9._%+-]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(match);
  if (!validMatch || !Number.isFinite(percent) || percent <= 0 || percent > 100) redirect(`${PAGE}?error=discount#discounts`);
  await scope.setDiscount(match, Math.round(percent * 100) / 100);
  await scope.audit("discount.set", { percent }, userId);
  redirect(`${PAGE}?saved=discount#discounts`);
}

export async function removeDiscount(formData: FormData) {
  const { scope, userId } = await session();
  await scope.deleteDiscount(text(formData.get("id"), 40));
  await scope.audit("discount.removed", {}, userId);
  redirect(`${PAGE}?saved=discount_removed#discounts`);
}
