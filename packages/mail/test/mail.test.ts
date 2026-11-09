import { describe, expect, it } from "vitest";
import {
  flagsFromHeaders,
  GraphAuthError,
  GraphClient,
  normalizeSubject,
  parsePostmarkInbound,
  refreshTokens,
  unwrapForward,
} from "../src";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("header flags", () => {
  it("recognises automatic replies, bulk mail and mailing lists", () => {
    expect(flagsFromHeaders([{ name: "Auto-Submitted", value: "auto-replied" }])).toEqual({ autoSubmitted: true });
    expect(flagsFromHeaders([{ name: "Auto-Submitted", value: "no" }])).toEqual({});
    expect(flagsFromHeaders([{ name: "precedence", value: "bulk" }, { name: "List-Unsubscribe", value: "<x>" }])).toEqual({ bulk: true, list: true });
  });

  it("normalises subjects across languages", () => {
    expect(normalizeSubject("Re: RE: Odp: Fwd: Oferta na pompy")).toBe("oferta na pompy");
  });
});

describe("Postmark forwarding intake", () => {
  const payload = {
    FromFull: { Email: "Tomasz.Bielak@nordpart.example", Name: "Tomasz Bielak" },
    ToFull: [{ Email: "nordpart@in.backoffice.example" }],
    OriginalRecipient: "nordpart@in.backoffice.example",
    Subject: "Fwd: Quote request: bearings",
    MessageID: "pm-123",
    Date: "Thu, 5 Nov 2026 09:10:00 +0100",
    TextBody:
      "---------- Forwarded message ---------\nFrom: Erik Halvorsen <erik@halvorsen-maskin.example>\nDate: Thu, 5 Nov 2026 at 09:02\nSubject: Quote request: bearings\nTo: <biuro@nordpart.example>\n\nHello Tomasz,\n\nCould you send prices?\n\nErik",
    Headers: [{ Name: "Message-ID", Value: "<fwd-1@nordpart.example>" }],
    Attachments: [{ Name: "bearing-list.xlsx" }],
  };

  it("finds the customer slug and unwraps a hand-forwarded mail to its real sender", () => {
    const parsed = parsePostmarkInbound(payload, "in.backoffice.example", (from) => from === "tomasz.bielak@nordpart.example");
    expect(parsed.slugs).toEqual(["nordpart"]);
    expect(parsed.forwardedBy).toBe("tomasz.bielak@nordpart.example");
    expect(parsed.message.from).toEqual({ address: "erik@halvorsen-maskin.example", name: "Erik Halvorsen" });
    expect(parsed.message.subject).toBe("Quote request: bearings");
    expect(parsed.message.bodyText).toBe("Hello Tomasz,\n\nCould you send prices?\n\nErik");
    expect(parsed.message.internetMessageId).toBe("<fwd-1@nordpart.example>");
    expect(parsed.message.attachmentNames).toEqual(["bearing-list.xlsx"]);
  });

  it("keeps the real sender when the mail was not forwarded by the customer", () => {
    const parsed = parsePostmarkInbound(payload, "in.backoffice.example", () => false);
    expect(parsed.message.from.address).toBe("tomasz.bielak@nordpart.example");
  });

  it("ignores recipients at other domains", () => {
    const parsed = parsePostmarkInbound({ ...payload, OriginalRecipient: "x@elsewhere.example", ToFull: [{ Email: "x@elsewhere.example" }] }, "in.backoffice.example");
    expect(parsed.slugs).toEqual([]);
  });

  it("unwraps Outlook-style and Polish forwards, and leaves ordinary mail alone", () => {
    const outlook = unwrapForward("FYI\n\n________________________________\nOd: Jan Kowalczyk <j.kowalczyk@rolmet.example>\nWysłano: środa, 5 listopada 2026 08:14\nDo: Biuro\nTemat: Dostępność pompy\n\nDzień dobry,\nczy macie pompę?");
    expect(outlook).toMatchObject({ from: "j.kowalczyk@rolmet.example", subject: "Dostępność pompy", body: "Dzień dobry,\nczy macie pompę?" });
    expect(unwrapForward("Hello,\n\nCan you send a quote?\n\nErik")).toBeNull();
    expect(unwrapForward("From: nobody@example.example")).toBeNull();
  });
});

describe("Microsoft Graph adapter", () => {
  it("creates a reply draft on the thread and never calls send", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (String(url).endsWith("/createReply")) {
        return json({ id: "draft-1", body: { contentType: "html", content: "<html><body><div>quoted original</div></body></html>" } });
      }
      return json({});
    }) as typeof fetch;

    const id = await new GraphClient("token", fakeFetch).createReplyDraft("msg-1", "Hello,\n<b>not html</b>");
    expect(id).toBe("draft-1");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://graph.microsoft.com/v1.0", "")}`)).toEqual([
      "POST /me/messages/msg-1/createReply",
      "PATCH /me/messages/draft-1",
    ]);
    const patched = JSON.parse(calls[1]!.body!).body.content as string;
    expect(patched).toContain("Hello,<br>&lt;b&gt;not html&lt;/b&gt;"); // our text, escaped, above
    expect(patched.indexOf("Hello,")).toBeLessThan(patched.indexOf("quoted original")); // the quoted original
    expect(calls.some((c) => c.url.includes("/send"))).toBe(false);
  });

  it("first poll only asks for mail received after the mailbox was connected", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return urls.length === 1
        ? json({ value: [{ id: "a" }, { id: "gone", "@removed": {} }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" })
        : json({ value: [{ id: "b" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-2" });
    }) as typeof fetch;
    const since = new Date("2026-11-09T10:00:00Z");
    const result = await new GraphClient("token", fakeFetch).listInboxDelta({ deltaLink: null, since });
    expect(decodeURIComponent(urls[0]!)).toContain("receivedDateTime ge 2026-11-09T10:00:00.000Z");
    expect(result).toEqual({ messageIds: ["a", "b"], deltaLink: "https://graph.microsoft.com/v1.0/delta-2" });
  });

  it("reports a revoked sign-in as 'needs reconnect', not as a generic failure", async () => {
    const fakeFetch = (async () => json({ error: "invalid_grant", error_description: "revoked" }, 400)) as typeof fetch;
    await expect(
      refreshTokens({ clientId: "id", clientSecret: "secret", tenant: "common", redirectUri: "https://app.test/cb", fetch: fakeFetch }, "old"),
    ).rejects.toBeInstanceOf(GraphAuthError);
  });
});
