/**
 * Every fixed text of the offer documents, in English. Another language is a
 * copy of this file with the same keys, registered in index.ts.
 */
export const en = {
  offer: "Offer",
  orderConfirmation: "Order confirmation",
  number: "No.",
  date: "Date",
  validUntil: "Valid until",
  forOffer: (number: string) => `For offer ${number}`,
  preparedFor: "Prepared for",
  position: "#",
  code: "Code",
  item: "Item",
  quantity: "Qty",
  unit: "Unit",
  unitPrice: "Unit price (net)",
  lineTotal: "Total (net)",
  netTotal: "Net total",
  discount: (percent: string) => `Discount ${percent}%`,
  netAfterDiscount: "Net after discount",
  vat: (rate: string) => `VAT ${rate}%`,
  grossTotal: "Total to pay",
  paymentTerms: "Payment terms",
  bankDetails: "Bank details",
  notAnInvoice: "This order confirmation is a pro forma document and is not a VAT invoice.",
  pricesNet: "Prices are net. VAT is added as shown.",
};

export type OfferStrings = typeof en;
