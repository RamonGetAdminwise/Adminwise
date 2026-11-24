import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addDaysIso, amountAppears, checkInvoice, dateAppears, daysBetween, extractPdfText, reminderDue, type ProposedInvoice } from "../src";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/nordpart/invoices");
const pdf = (name: string) => new Uint8Array(readFileSync(path.join(dir, name)));
const fixtures = JSON.parse(readFileSync(path.join(dir, "invoices.json"), "utf8")) as {
  invoices: { id: string; file: string; expected: Record<string, unknown>; recorded: Record<string, unknown> | null }[];
};
const proposal = (r: Record<string, unknown>): ProposedInvoice => ({
  number: r.number as string | null,
  grossAmount: r.gross_amount as string | null,
  currency: r.currency as string | null,
  issueDate: r.issue_date as string | null,
  dueDate: r.due_date as string | null,
  paymentTermDays: r.payment_term_days as number | null,
  buyer: r.buyer as string | null,
});

describe("reading the text of a PDF", () => {
  it("gets the text of an invoice, Polish characters included", async () => {
    const text = (await extractPdfText(pdf("FV_2026_11_0457.pdf")))!;
    expect(text).toContain("Faktura VAT nr FV/2026/11/0457");
    expect(text).toContain("Termin płatności: 2026-11-17");
    expect(text).toContain("Do zapłaty: 26 372,43 PLN");
  });

  it("says so when there is nothing to read", async () => {
    expect(await extractPdfText(pdf("skan_faktury.pdf"))).toBeNull(); // a scan: a picture, no text
    expect(await extractPdfText(new TextEncoder().encode("this is not a pdf at all, just some text in a file"))).toBeNull();
    expect(await extractPdfText(new Uint8Array(0))).toBeNull();
  });
});

describe("checking what was read against the invoice itself", () => {
  it("finds amounts and dates however they are printed", () => {
    expect(amountAppears("Do zapłaty: 26 372,43 PLN", 2637243)).toBe(true);
    expect(amountAppears("Total due: 18,314.70 PLN", 1831470)).toBe(true);
    expect(amountAppears("Razem 615,00 zł", 61500)).toBe(true);
    expect(amountAppears("Razem 615 zł", 61500)).toBe(true);
    expect(amountAppears("Total 1.234,50 EUR", 123450)).toBe(true);
    expect(amountAppears("Do zapłaty: 26 372,43 PLN", 2637244)).toBe(false);
    expect(amountAppears("Do zapłaty: 126 372,43 PLN", 2637243)).toBe(false); // part of a larger number
    expect(amountAppears("Kod 61500", 61500)).toBe(false);

    for (const printed of ["2026-11-17", "17.11.2026", "17-11-2026", "17/11/2026", "17.11.26"]) {
      expect(dateAppears(`Termin płatności: ${printed}`, "2026-11-17"), printed).toBe(true);
    }
    expect(dateAppears("Termin: 03.11.2026", "2026-11-03")).toBe(true);
    expect(dateAppears("Termin: 3.11.2026", "2026-11-03")).toBe(true);
    expect(dateAppears("Termin: 2026-11-18", "2026-11-17")).toBe(false);
    expect(dateAppears("nr 1117112026", "2026-11-17")).toBe(false);
    // The month as a word, in the languages invoices arrive in.
    for (const printed of [
      "Due date: 8 December 2026", "due 8th December 2026", "December 8, 2026", "Dec 8 2026", "8 Dec. 2026", "08-Dec-2026",
      "Fällig am 8. Dezember 2026", "Vervaldatum: 8 december 2026", "Termin płatności: 8 grudnia 2026", "8 prosince 2026",
    ]) {
      expect(dateAppears(printed, "2026-12-08"), printed).toBe(true);
    }
    expect(dateAppears("18 December 2026", "2026-12-08")).toBe(false);
    expect(dateAppears("8 December 2027", "2026-12-08")).toBe(false);
    expect(dateAppears("8 November 2026", "2026-12-08")).toBe(false);
    expect(dateAppears("8 marca 2026", "2026-03-08")).toBe(true);
    expect(dateAppears("8 czerwca 2026", "2026-07-08")).toBe(false);
    expect(dateAppears("8. července 2026", "2026-06-08")).toBe(false);
  });

  it("reads each Nordpart invoice as expected", async () => {
    for (const f of fixtures.invoices.filter((i) => i.expected.status === "open" || i.expected.status === "needs_due_date")) {
      const text = (await extractPdfText(pdf(f.file)))!;
      const checked = checkInvoice(text, proposal(f.recorded!), "PLN");
      expect(checked, f.id).toEqual({
        number: f.expected.number, amountCents: f.expected.amountCents, currency: f.expected.currency,
        issueDate: f.expected.issueDate, dueDate: f.expected.dueDate, buyer: f.expected.buyer,
      });
    }
  });

  it("counts a due date from a printed payment term, and only from a printed one", () => {
    const text = "Invoice No. INV-1\nInvoice date: 03.11.2026\nPayment terms: 14 days net\nTotal due: 100.00 EUR";
    const base: ProposedInvoice = { number: "INV-1", grossAmount: "100.00", currency: "EUR", issueDate: "2026-11-03", dueDate: null, paymentTermDays: 14, buyer: null };
    expect(checkInvoice(text, base, "PLN")).toMatchObject({ dueDate: "2026-11-17", currency: "EUR", amountCents: 10000 });
    // The model says 30 days, the invoice says 14: not used.
    expect(checkInvoice(text, { ...base, paymentTermDays: 30 }, "PLN").dueDate).toBeNull();
    expect(addDaysIso("2026-12-25", 14)).toBe("2027-01-08");
  });

  it("drops everything the invoice does not confirm", () => {
    const text = "Faktura VAT nr FV/1\nData wystawienia: 2026-11-05\nDo zapłaty: 500,00 zł\nNabywca: Stalbud S.A.";
    const invented: ProposedInvoice = { number: "FV/999", grossAmount: "5 000,00", currency: "USD", issueDate: "2026-11-06", dueDate: "2026-11-19", paymentTermDays: null, buyer: "Rolmet" };
    expect(checkInvoice(text, invented, "EUR")).toEqual({ number: null, amountCents: null, currency: "PLN", issueDate: null, dueDate: null, buyer: "" });
    // A due date before the issue date is a misreading, even if both are printed.
    const odd = "FV/1 wystawiono 2026-11-05, zamówienie z 2026-10-01, do zapłaty 500,00 zł";
    expect(checkInvoice(odd, { ...invented, number: "FV/1", grossAmount: "500,00", issueDate: "2026-11-05", dueDate: "2026-10-01" }, "PLN").dueDate).toBeNull();
  });
});

describe("the reminder chain", () => {
  const invoice = { dueDate: "2026-11-17", remindersMade: 0, lastReminderOn: null as string | null };

  it("drafts reminders 7, 14 and 30 days after the due date", () => {
    expect(daysBetween("2026-11-17", "2026-11-24")).toBe(7);
    expect(reminderDue(invoice, "2026-11-23")).toBeNull();
    expect(reminderDue(invoice, "2026-11-24")).toBe(1);
    expect(reminderDue({ ...invoice, remindersMade: 1, lastReminderOn: "2026-11-24" }, "2026-11-30")).toBeNull();
    expect(reminderDue({ ...invoice, remindersMade: 1, lastReminderOn: "2026-11-24" }, "2026-12-01")).toBe(2);
    expect(reminderDue({ ...invoice, remindersMade: 2, lastReminderOn: "2026-12-01" }, "2026-12-16")).toBeNull();
    expect(reminderDue({ ...invoice, remindersMade: 2, lastReminderOn: "2026-12-01" }, "2026-12-17")).toBe(3);
    expect(reminderDue({ ...invoice, remindersMade: 3, lastReminderOn: "2026-12-17" }, "2027-03-01")).toBeNull();
  });

  it("never stacks reminders for an invoice that is first seen long overdue", () => {
    expect(reminderDue(invoice, "2027-01-10")).toBe(1);
    expect(reminderDue({ ...invoice, remindersMade: 1, lastReminderOn: "2027-01-10" }, "2027-01-11")).toBeNull();
    expect(reminderDue({ ...invoice, remindersMade: 1, lastReminderOn: "2027-01-10" }, "2027-01-17")).toBe(2);
  });
});
