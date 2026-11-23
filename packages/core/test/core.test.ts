import { randomBytes } from "node:crypto";
import { createDb, forCustomer, system, type Db } from "@adminwise/db";
import { GraphAuthError } from "@adminwise/mail";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { addDays, createOutlookGateway, isValidTimeZone, loadConfig, localClock, startOfLocalDay } from "../src";

describe("time zones", () => {
  it("reads the customer's wall clock", () => {
    expect(localClock(new Date("2026-11-10T06:30:00Z"), "Europe/Warsaw")).toEqual({ date: "2026-11-10", minutesOfDay: 450 });
    expect(localClock(new Date("2026-11-10T03:00:00Z"), "America/New_York")).toEqual({ date: "2026-11-09", minutesOfDay: 22 * 60 });
  });

  it("finds the start of a local day, also across daylight-saving changes", () => {
    expect(startOfLocalDay("2026-11-10", "Europe/Warsaw").toISOString()).toBe("2026-11-09T23:00:00.000Z");
    expect(startOfLocalDay("2026-07-01", "Europe/Warsaw").toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(startOfLocalDay("2026-03-29", "Europe/Warsaw").toISOString()).toBe("2026-03-28T23:00:00.000Z"); // clocks go forward that night
    expect(startOfLocalDay("2026-11-10", "Asia/Tokyo").toISOString()).toBe("2026-11-09T15:00:00.000Z");
  });

  it("validates IANA names and steps dates", () => {
    expect(isValidTimeZone("Europe/Amsterdam")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("config", () => {
  it("keeps region and per-task models in configuration, with EU defaults", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://x", TOKEN_ENCRYPTION_KEY: "k" } as NodeJS.ProcessEnv);
    const haiku = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
    // Writing jobs use the default model; the sorting jobs (mail, follow-up check, document type) use the classify model.
    expect(config.aws).toEqual({
      region: "eu-central-1",
      models: { default: "eu.anthropic.claude-sonnet-4-6", classify: haiku, "chaser-check": haiku, "file-type": haiku, "price-list-columns": haiku, "offer-acceptance": haiku, "payment-notice": haiku },
    });
    expect(config.alertEmail).toBeNull();
    const base = { DATABASE_URL: "x", TOKEN_ENCRYPTION_KEY: "k" };
    // Switching a task to another model is one line of configuration.
    expect(loadConfig({ ...base, BEDROCK_MODEL_DRAFT: "eu.anthropic.claude-sonnet-5", AWS_REGION: "eu-west-1" } as NodeJS.ProcessEnv).aws).toEqual({
      region: "eu-west-1",
      models: { default: "eu.anthropic.claude-sonnet-5", classify: haiku, "chaser-check": haiku, "file-type": haiku, "price-list-columns": haiku, "offer-acceptance": haiku, "payment-notice": haiku },
    });
    expect(loadConfig({ ...base, ALERT_EMAIL: " ops@adminwise.example " } as NodeJS.ProcessEnv).alertEmail).toBe("ops@adminwise.example");
    // The global endpoint is refused: it may process requests outside the EU.
    expect(() => loadConfig({ ...base, BEDROCK_MODEL_CLASSIFY: "global.anthropic.claude-haiku-4-5-20251001-v1:0" } as NodeJS.ProcessEnv)).toThrow(/global inference profile/);
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });
});

describe("Outlook gateway token handling", () => {
  let db: Db;
  beforeAll(() => {
    db = createDb({ connectionString: inject("databaseUrl"), encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  });
  afterAll(async () => {
    await db.close();
  });

  async function customerWithMailbox(tokenExpiresAt: Date) {
    const tag = randomBytes(4).toString("hex");
    const { customerId } = await system(db).createCustomerWithUser({ email: `owner.${tag}@gateway.example`, slug: `gateway-${tag}` });
    const scope = forCustomer(db, customerId);
    const connection = await scope.upsertConnection({
      provider: "microsoft",
      emailAddress: `owner.${tag}@gateway.example`,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenExpiresAt,
    });
    return { scope, connectionId: connection.id };
  }

  const oauth = { clientId: "id", clientSecret: "secret", tenant: "common", redirectUri: "https://app.test/cb" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("refreshes an expiring token before using the mailbox and stores the new one", async () => {
    const { scope, connectionId } = await customerWithMailbox(new Date(Date.now() + 60_000)); // expires in 1 minute
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/oauth2/v2.0/token")) return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      seen.push((init?.headers as Record<string, string>).authorization!);
      return u.endsWith("/createReply") ? json({ id: "draft-9", body: { content: "" } }) : json({});
    }) as typeof fetch;

    const gateway = createOutlookGateway({ oauth: { ...oauth, fetch: fakeFetch }, notificationUrl: null });
    expect(await gateway.createReplyDraft(scope, connectionId, "msg-1", "Hello")).toBe("draft-9");
    expect(seen.every((h) => h === "Bearer new-access")).toBe(true);
    const stored = (await scope.getConnection(connectionId))!;
    expect(stored.accessToken).toBe("new-access");
    expect(stored.refreshToken).toBe("new-refresh");
    expect(stored.status).toBe("active");
  });

  it("marks the connection 'needs_reconnect' when Microsoft no longer accepts the sign-in", async () => {
    const { scope, connectionId } = await customerWithMailbox(new Date(Date.now() - 1000)); // already expired
    const fakeFetch = (async () => json({ error: "invalid_grant" }, 400)) as typeof fetch;
    const gateway = createOutlookGateway({ oauth: { ...oauth, fetch: fakeFetch }, notificationUrl: null });

    await expect(gateway.createReplyDraft(scope, connectionId, "msg-1", "Hello")).rejects.toBeInstanceOf(GraphAuthError);
    const stored = (await scope.getConnection(connectionId))!;
    expect(stored.status).toBe("needs_reconnect");
    expect(stored.lastError).toBe("invalid_grant");
    // From now on the mailbox is left alone until the customer reconnects.
    await expect(gateway.createReplyDraft(scope, connectionId, "msg-1", "Hello")).rejects.toThrow("needs_reconnect");
  });
});
