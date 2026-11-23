import type { OfferStrings } from "./en";

/** The offer documents' fixed texts in Polish. Same keys as en.ts. */
export const pl: OfferStrings = {
  offer: "Oferta",
  orderConfirmation: "Potwierdzenie zamówienia",
  number: "Nr",
  date: "Data",
  validUntil: "Ważna do",
  forOffer: (number) => `Do oferty ${number}`,
  preparedFor: "Przygotowano dla",
  position: "Lp.",
  code: "Indeks",
  item: "Nazwa",
  quantity: "Ilość",
  unit: "J.m.",
  unitPrice: "Cena jedn. netto",
  lineTotal: "Wartość netto",
  netTotal: "Razem netto",
  discount: (percent) => `Rabat ${percent}%`,
  netAfterDiscount: "Netto po rabacie",
  vat: (rate) => `VAT ${rate}%`,
  grossTotal: "Do zapłaty",
  paymentTerms: "Warunki płatności",
  bankDetails: "Dane bankowe",
  notAnInvoice: "Potwierdzenie zamówienia ma charakter pro forma i nie jest fakturą VAT.",
  pricesNet: "Ceny netto. Podatek VAT doliczany zgodnie z zestawieniem.",
};
