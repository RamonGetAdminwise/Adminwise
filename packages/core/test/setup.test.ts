import { describe, expect, it } from "vitest";
import { setupTestMail, setupTestState, testMailWouldBeInternal } from "../src";

const FROM = "Adminwise <hello@adminwise.example>";

describe("the guided test at the end of setup", () => {
  it("writes the test mail in the owner's first language, as an ordinary customer question", () => {
    const en = setupTestMail(["en", "pl"], "Adminwise");
    expect(en.subject).toBe("Question about your delivery time");
    expect(en.textBody).toContain("Could you tell me how quickly you usually deliver");
    expect(en.textBody).toContain("test email you asked for in the Getting started guide of Adminwise");

    const pl = setupTestMail(["pl"], "Adminwise");
    expect(pl.subject).toBe("Pytanie o termin dostawy");
    expect(pl.textBody).toContain("Dzień dobry,");

    // Any other language, or none yet: English.
    expect(setupTestMail(["de"], "Adminwise").subject).toBe(en.subject);
    expect(setupTestMail([], "Adminwise").subject).toBe(en.subject);
    // Nothing in it looks like an automatic message, which would get no draft.
    expect(`${en.subject} ${pl.subject}`).not.toMatch(/test|automatic|auto/i);
  });

  it("knows when our own sending address would count as a colleague", () => {
    expect(testMailWouldBeInternal(FROM, ["owner@nordpart.example", "biuro@nordpart.example", "nordpart"])).toBe(false);
    expect(testMailWouldBeInternal(FROM, ["someone@Adminwise.example"])).toBe(true);
    expect(testMailWouldBeInternal("hello@adminwise.example", ["someone@adminwise.example"])).toBe(true);
  });

  it("reads where the test stands from the activity log", () => {
    const sentAt = new Date("2026-11-24T09:00:00Z");
    const run = (outcome: string | null, startedAt: string, job = "reply-draft", status = "succeeded") => ({ job, status, outcome, startedAt: new Date(startedAt) });
    const soon = new Date("2026-11-24T09:02:00Z");

    expect(setupTestState(null, [run("drafted:outlook", "2026-11-24T08:00:00Z")], soon)).toBe("not_sent");
    expect(setupTestState(sentAt, [], soon)).toBe("waiting");
    // A draft from before the test, another job, or a run still failing, is not the answer.
    expect(setupTestState(sentAt, [run("drafted:outlook", "2026-11-24T08:59:00Z"), run("new_mail:1", "2026-11-24T09:01:00Z", "sync-mailbox"), run(null, "2026-11-24T09:01:00Z", "reply-draft", "failed")], soon)).toBe("waiting");
    expect(setupTestState(sentAt, [run("drafted:outlook", "2026-11-24T09:01:00Z")], soon)).toBe("drafted");
    expect(setupTestState(sentAt, [run("drafted:email", "2026-11-24T09:01:00Z")], soon)).toBe("drafted");
    expect(setupTestState(sentAt, [run("clarify:outlook", "2026-11-24T09:01:00Z")], soon)).toBe("drafted");
    expect(setupTestState(sentAt, [run("no_draft:switched_off", "2026-11-24T09:01:00Z")], soon)).toBe("no_draft");
    // One mail without a draft and one with: the test worked.
    expect(setupTestState(sentAt, [run("no_draft:newsletter", "2026-11-24T09:01:00Z"), run("drafted:outlook", "2026-11-24T09:02:00Z")], soon)).toBe("drafted");
    expect(setupTestState(sentAt, [], new Date("2026-11-24T09:11:00Z"))).toBe("nothing_arrived");
  });
});
