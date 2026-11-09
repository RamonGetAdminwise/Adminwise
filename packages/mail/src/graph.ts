import { flagsFromHeaders, type InboundMessage } from "./types";

/**
 * Microsoft 365 adapter (Microsoft Graph, delegated permissions).
 * Plain fetch calls so there is no SDK to keep up with; `fetch` can be
 * replaced in tests.
 */

export const GRAPH_SCOPES = ["offline_access", "User.Read", "Mail.Read", "Mail.ReadWrite"];
const GRAPH = "https://graph.microsoft.com/v1.0";
/** Subscriptions on mail expire; we ask for 2 days and renew daily from the polling job. */
const SUBSCRIPTION_MINUTES = 2880;

export interface GraphOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** "common" lets any Microsoft 365 organisation connect. */
  tenant: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** The customer must reconnect: token revoked, password changed, admin removed consent. */
export class GraphAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "GraphAuthError";
  }
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export function buildAuthUrl(cfg: GraphOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    response_mode: "query",
    scope: GRAPH_SCOPES.join(" "),
    state,
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize?${params}`;
}

async function tokenRequest(cfg: GraphOAuthConfig, body: Record<string, string>): Promise<TokenSet> {
  const doFetch = cfg.fetch ?? fetch;
  const response = await doFetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: GRAPH_SCOPES.join(" "),
      ...body,
    }),
  });
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.access_token || !json.refresh_token) {
    const code = json.error ?? `http_${response.status}`;
    // invalid_grant / interaction_required / consent_required: only the customer can fix it.
    if (["invalid_grant", "interaction_required", "consent_required", "invalid_client"].includes(code)) {
      throw new GraphAuthError(`Microsoft sign-in is no longer valid (${code})`, code);
    }
    throw new GraphError(`Token request failed (${code})`, response.status);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
  };
}

export function exchangeCode(cfg: GraphOAuthConfig, code: string): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
}

export function refreshTokens(cfg: GraphOAuthConfig, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name: string; value: string }[];
  attachments?: { name?: string }[];
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class GraphClient {
  constructor(
    private readonly accessToken: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private async request<T>(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<T> {
    const response = await this.doFetch(url.startsWith("http") ? url : `${GRAPH}${url}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (response.status === 401) {
      throw new GraphAuthError("Microsoft rejected the access token", "unauthorized");
    }
    if (!response.ok) {
      // Only the status and Graph's error code: never response bodies, they can hold mail content.
      let code = "";
      try {
        code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? "";
      } catch {
        // ignore
      }
      throw new GraphError(`Graph ${init.method ?? "GET"} failed: ${response.status} ${code}`.trim(), response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async getMe(): Promise<{ email: string }> {
    const me = await this.request<{ mail?: string; userPrincipalName?: string }>("/me?$select=mail,userPrincipalName");
    return { email: (me.mail ?? me.userPrincipalName ?? "").toLowerCase() };
  }

  async getMessage(id: string): Promise<InboundMessage> {
    const m = await this.request<GraphMessage>(
      `/me/messages/${encodeURIComponent(id)}` +
        "?$select=id,internetMessageId,conversationId,subject,from,receivedDateTime,body,internetMessageHeaders" +
        "&$expand=attachments($select=name)",
      { headers: { prefer: 'outlook.body-content-type="text"' } },
    );
    return {
      providerMessageId: m.id,
      internetMessageId: m.internetMessageId ?? null,
      threadKey: m.conversationId ?? m.internetMessageId ?? m.id,
      subject: m.subject ?? "",
      from: {
        address: (m.from?.emailAddress?.address ?? "").toLowerCase(),
        name: m.from?.emailAddress?.name ?? "",
      },
      receivedAt: new Date(m.receivedDateTime ?? Date.now()),
      bodyText: m.body?.content ?? "",
      headerFlags: flagsFromHeaders(m.internetMessageHeaders ?? []),
      attachmentNames: (m.attachments ?? []).map((a) => a.name ?? "").filter(Boolean),
    };
  }

  /**
   * Polling fallback. First call: pass `since` (the moment the mailbox was
   * connected) so old mail is never picked up. Later calls: pass the deltaLink
   * returned last time and get only what arrived since.
   */
  async listInboxDelta(input: { deltaLink: string | null; since: Date }): Promise<{
    messageIds: string[];
    deltaLink: string;
  }> {
    let url: string =
      input.deltaLink ??
      "/me/mailFolders/inbox/messages/delta?$select=id" +
        `&$filter=${encodeURIComponent(`receivedDateTime ge ${input.since.toISOString()}`)}`;
    const messageIds: string[] = [];
    for (let page = 0; page < 50; page++) {
      const result = await this.request<{
        value: { id: string; "@removed"?: unknown }[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      }>(url);
      for (const item of result.value) {
        if (!item["@removed"]) messageIds.push(item.id);
      }
      if (result["@odata.deltaLink"]) return { messageIds, deltaLink: result["@odata.deltaLink"] };
      if (!result["@odata.nextLink"]) break;
      url = result["@odata.nextLink"];
    }
    throw new GraphError("Inbox delta did not finish", 500);
  }

  /**
   * Creates a reply in the customer's Drafts folder, on the original thread,
   * with our text above the quoted original. Nothing is sent.
   */
  async createReplyDraft(messageId: string, text: string): Promise<string> {
    const draft = await this.request<GraphMessage>(`/me/messages/${encodeURIComponent(messageId)}/createReply`, {
      method: "POST",
      body: "{}",
    });
    const html = `<div>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</div><br>`;
    const quoted = draft.body?.content ?? "";
    // Put our text right after <body ...> when the quoted reply is a full HTML document.
    const content = /<body[^>]*>/i.test(quoted)
      ? quoted.replace(/<body[^>]*>/i, (tag) => `${tag}${html}`)
      : `${html}${quoted}`;
    await this.request(`/me/messages/${encodeURIComponent(draft.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ body: { contentType: "HTML", content } }),
    });
    return draft.id;
  }

  async createSubscription(notificationUrl: string, clientState: string): Promise<{ id: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000);
    const sub = await this.request<{ id: string; expirationDateTime: string }>("/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        changeType: "created",
        notificationUrl,
        resource: "me/mailFolders('inbox')/messages",
        expirationDateTime: expiresAt.toISOString(),
        clientState,
      }),
    });
    return { id: sub.id, expiresAt: new Date(sub.expirationDateTime) };
  }

  async renewSubscription(id: string): Promise<Date> {
    const expiresAt = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000);
    const sub = await this.request<{ expirationDateTime: string }>(`/subscriptions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }),
    });
    return new Date(sub.expirationDateTime);
  }
}
