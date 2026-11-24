import { describe, expect, it } from "vitest";
import { checkExpectsReply, checkOfferAccepted, checkPaymentNotice, type AiClient } from "../src";

/** Faults found by the independent review of 2026-11-24, in reading model answers. */

const answering = (text: string): AiClient => ({ complete: async () => ({ text, inputTokens: 1, outputTokens: 1 }) });

describe("a model that answers, reconsiders and answers again", () => {
  it("is taken at its last answer, in every job", async () => {
    const twice = (a: string, b: string) => answering(`${a}\n\nWait, reading it again: that is a promise, not a payment.\n\n${b}`);
    const notice = { companyName: "Nordpart", invoiceNumbers: ["FV/1"], subject: "Re: FV/1", body: "Zapłacimy w przyszłym tygodniu." };
    expect((await checkPaymentNotice(twice('{"paid":"yes","invoices":["FV/1"]}', '{"paid":"no","invoices":[]}'), notice)).paid).toBe(false);
    const offer = { companyName: "Nordpart", offerNumber: "OF/2026/001", subject: "Re: oferta", body: "A ile kosztuje dostawa?" };
    expect((await checkOfferAccepted(twice('{"accepts":"yes"}', '{"accepts":"no"}'), offer)).accepted).toBe(false);
    const sent = { companyName: "Nordpart", subject: "Oferta", body: "W załączeniu oferta." };
    expect((await checkExpectsReply(twice('{"expects_reply":"no"}', '{"expects_reply":"yes"}'), sent)).expectsReply).toBe(true);
  });
});

describe("which invoices a sender says they paid", () => {
  const input = { companyName: "Nordpart", invoiceNumbers: ["FV/2026/11/0457", "INV-2026-118"], subject: "Re: faktury" };
  it("keeps only numbers we asked about that the sender also wrote", async () => {
    const ai = answering('{"paid":"yes","invoices":["FV/2026/11/0457","INV-2026-118","FV/9999"]}');
    const got = await checkPaymentNotice(ai, { ...input, body: "Faktura FV 2026/11/0457 została zapłacona." });
    expect(got).toMatchObject({ paid: true, numbers: ["FV/2026/11/0457"] });
  });
  it("names none when the sender named none", async () => {
    const got = await checkPaymentNotice(answering('{"paid":"yes","invoices":[]}'), { ...input, body: "Zapłaciliśmy wczoraj." });
    expect(got).toMatchObject({ paid: true, numbers: [] });
  });
});
