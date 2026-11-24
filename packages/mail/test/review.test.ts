import { describe, expect, it } from "vitest";
import { flagsFromHeaders, parsePostmarkInbound, senderVerified } from "../src";

/** Faults found by the independent review of 2026-11-24, on the forwarding address. */

const spf = (value: string) => [{ Name: "Received-SPF", Value: value }];

describe("who really sent a forwarded mail", () => {
  const from = { FromFull: { Email: "owner@nordpart.example" } };
  it("believes the From line only when the receiving server's sender check passed for that domain", () => {
    expect(senderVerified({ ...from, Headers: spf("Pass (sender SPF authorized) identity=mailfrom; client-ip=1.2.3.4; envelope-from=owner@nordpart.example; receiver=x") })).toBe(true);
    expect(senderVerified({ ...from, Headers: spf("Pass (sender SPF authorized) identity=mailfrom; envelope-from=bounce@mail.nordpart.example; receiver=x") })).toBe(true);
    // Someone else's server, writing the owner's address in the From line.
    expect(senderVerified({ ...from, Headers: spf("Fail (not authorized) identity=mailfrom; envelope-from=owner@nordpart.example; receiver=x") })).toBe(false);
    expect(senderVerified({ ...from, Headers: spf("SoftFail identity=mailfrom; envelope-from=owner@nordpart.example") })).toBe(false);
    // Their own server passes its own check, but for another domain.
    expect(senderVerified({ ...from, Headers: spf("Pass identity=mailfrom; envelope-from=evil@attacker.example; receiver=x") })).toBe(false);
  });
  it("cannot tell when no check is reported, and then behaves as before", () => {
    expect(senderVerified({ ...from, Headers: [] })).toBe(true);
  });
});

describe("conversations without message references", () => {
  const mail = (address: string) =>
    parsePostmarkInbound(
      { FromFull: { Email: address }, ToFull: [{ Email: "nordpart@in.getadminwise.com" }], Subject: "Zapytanie", TextBody: "Dzień dobry", MessageID: address },
      "in.getadminwise.com",
      false,
    ).message.threadKey;
  it("two strangers at a mailbox provider with the same subject are two conversations", () => {
    expect(mail("anna@gmail.com")).not.toBe(mail("piotr@gmail.com"));
    expect(mail("anna@gmail.com")).toBe(mail("anna@gmail.com"));
  });
  it("two people of one company on the same subject are still one", () => {
    expect(mail("anna@rolmet.example")).toBe(mail("piotr@rolmet.example"));
  });
});

describe("header flags", () => {
  it("a mail that only asks not to be auto-replied to is not itself an automatic reply", () => {
    expect(flagsFromHeaders([{ name: "X-Auto-Response-Suppress", value: "All" }])).toEqual({});
    expect(flagsFromHeaders([{ name: "Auto-Submitted", value: "auto-replied" }])).toEqual({ autoSubmitted: true });
  });
});
