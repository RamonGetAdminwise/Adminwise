import { flagsFromHeaders, type AttachmentInfo, type InboundMessage, type OutboundAttachment } from "./types";

/**
 * Microsoft 365 adapter (Microsoft Graph, delegated permissions).
 * Plain fetch calls so there is no SDK to keep up with; `fetch` can be
 * replaced in tests.
 */

/**
 * Files.ReadWrite.AppFolder gives access to the app's own folder in the
 * customer's OneDrive (Apps/<app name>) and nothing else in their drive.
 * There is no Mail.Send: the product never sends from a customer's mailbox.
 */
export const GRAPH_SCOPES = ["offline_access", "User.Read", "Mail.Read", "Mail.ReadWrite", "Files.ReadWrite.AppFolder"];
const GRAPH = "https://graph.microsoft.com/v1.0";
/** Above this size a file goes up through an upload session instead of one plain request. */
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Microsoft takes attachments up to 3 MB in one request; an offer PDF is far below that. */
const MAX_DRAFT_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** One request of an upload session must stay under 60 MiB; larger files are not filed. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
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
  /** The permissions Microsoft actually granted, space-separated. */
  scopes: string;
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
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
  });
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
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
    scopes: json.scope ?? "",
  };
}

export function exchangeCode(cfg: GraphOAuthConfig, code: string): Promise<TokenSet> {
  return tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    scope: GRAPH_SCOPES.join(" "),
  });
}

/**
 * No scope is named on refresh, so Microsoft renews exactly what the customer
 * approved. A mailbox connected before a permission was added keeps working
 * with its old permissions instead of being refused.
 */
export function refreshTokens(cfg: GraphOAuthConfig, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name: string; value: string }[];
  attachments?: { name?: string }[];
}

const addresses = (list: { emailAddress?: { address?: string } }[] | undefined): string[] =>
  (list ?? []).map((r) => (r.emailAddress?.address ?? "").toLowerCase()).filter(Boolean);

/** Only the status and Graph's error code: never response bodies, they can hold mail content. */
async function graphError(method: string, response: Response): Promise<GraphError> {
  let code = "";
  try {
    code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? "";
  } catch {
    // ignore
  }
  return new GraphError(`Graph ${method} failed: ${response.status} ${code}`.trim(), response.status);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class GraphClient {
  constructor(
    private readonly accessToken: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  /** One authorised call; returns the raw response so callers can read JSON or bytes. */
  private async send(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
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
    if (!response.ok) throw await graphError(init.method ?? "GET", response);
    return response;
  }

  private async request<T>(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<T> {
    const response = await this.send(url, init);
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
        "?$select=id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body," +
        "internetMessageHeaders" +
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
      to: addresses(m.toRecipients),
      cc: addresses(m.ccRecipients),
    };
  }

  /** Same as listInboxDelta, for the Sent Items folder: what the customer sent since last time. */
  listSentDelta(input: { deltaLink: string | null; since: Date }) {
    return this.listFolderDelta("sentitems", input);
  }

  /**
   * Polling fallback. First call: pass `since` (the moment the mailbox was
   * connected) so old mail is never picked up. Later calls: pass the deltaLink
   * returned last time and get only what arrived since.
   */
  listInboxDelta(input: { deltaLink: string | null; since: Date }) {
    return this.listFolderDelta("inbox", input);
  }

  private async listFolderDelta(
    folder: "inbox" | "sentitems",
    input: { deltaLink: string | null; since: Date },
  ): Promise<{ messageIds: string[]; deltaLink: string }> {
    let url: string =
      input.deltaLink ??
      `/me/mailFolders/${folder}/messages/delta?$select=id` +
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
    throw new GraphError("Mail folder delta did not finish", 500);
  }

  /**
   * A follow-up on the customer's own sent message: a draft in the same thread,
   * addressed to the people the original went to, with our text above the
   * quoted original. Nothing is sent.
   */
  async createChaserDraft(sentMessageId: string, text: string, to: string[], cc: string[]): Promise<string> {
    const draftId = await this.createReplyDraft(sentMessageId, text);
    const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));
    await this.request(`/me/messages/${encodeURIComponent(draftId)}`, {
      method: "PATCH",
      body: JSON.stringify({ toRecipients: recipients(to), ccRecipients: recipients(cc) }),
    });
    return draftId;
  }

  /** Is the draft we created still sitting unsent in the mailbox? Sent or deleted drafts get a new id, so they are "gone". */
  async isDraftWaiting(draftId: string): Promise<boolean> {
    try {
      const m = await this.request<{ isDraft?: boolean }>(`/me/messages/${encodeURIComponent(draftId)}?$select=id,isDraft`);
      return m.isDraft === true;
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return false;
      throw error;
    }
  }

  /** Removes a draft we created ourselves (the customer chose "not this time"). A draft that is already gone is fine. */
  async deleteDraft(draftId: string): Promise<void> {
    try {
      await this.request(`/me/messages/${encodeURIComponent(draftId)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return;
      throw error;
    }
  }

  // ---- attachments and OneDrive ------------------------------------------------

  /** The files attached to a message, without their content. Attached emails and links are left out. */
  async listAttachments(messageId: string): Promise<AttachmentInfo[]> {
    const result = await this.request<{
      value: { "@odata.type"?: string; id: string; name?: string; contentType?: string; size?: number; isInline?: boolean }[];
    }>(`/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`);
    return result.value
      .filter((a) => (a["@odata.type"] ?? "#microsoft.graph.fileAttachment") === "#microsoft.graph.fileAttachment")
      .map((a) => ({
        id: a.id,
        name: a.name ?? "",
        contentType: a.contentType ?? "application/octet-stream",
        sizeBytes: a.size ?? 0,
        isInline: a.isInline === true,
      }));
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const response = await this.send(
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Saves a file inside the app's own OneDrive folder. `path` is relative to
   * that folder ("rolmet.example/2026-11/2026-11-20_invoice_FV-1.pdf"); missing
   * folders are created. An existing file with the same name is never
   * overwritten: Microsoft answers 409 and the caller picks another name.
   */
  async uploadToAppFolder(path: string, content: Uint8Array, contentType: string): Promise<{ itemId: string }> {
    const target = `/me/drive/special/approot:/${path.split("/").map(encodeURIComponent).join("/")}`;
    if (content.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      const response = await this.send(`${target}:/content?@microsoft.graph.conflictBehavior=fail`, {
        method: "PUT",
        headers: { "content-type": contentType || "application/octet-stream" },
        body: content as RequestInit["body"],
      });
      return { itemId: ((await response.json()) as { id: string }).id };
    }
    const session = await this.request<{ uploadUrl: string }>(`${target}:/createUploadSession`, {
      method: "POST",
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "fail" } }),
    });
    // The upload address carries its own authorisation: no bearer token is sent to it.
    const response = await this.doFetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "content-length": String(content.byteLength),
        "content-range": `bytes 0-${content.byteLength - 1}/${content.byteLength}`,
      },
      body: content as RequestInit["body"],
    });
    if (!response.ok) throw await graphError("PUT", response);
    return { itemId: ((await response.json()) as { id: string }).id };
  }

  /**
   * Creates a reply in the customer's Drafts folder, on the original thread,
   * with our text above the quoted original. Nothing is sent.
   */
  async createReplyDraft(messageId: string, text: string, attachments: OutboundAttachment[] = []): Promise<string> {
    const draft = await this.request<GraphMessage>(`/me/messages/${encodeURIComponent(messageId)}/createReply`, {
      method: "POST",
      body: "{}",
    });
    // Files we made ourselves (an offer PDF), added to the draft. Small files only: one plain request each.
    for (const attachment of attachments) {
      if (attachment.content.byteLength > MAX_DRAFT_ATTACHMENT_BYTES) {
        throw new GraphError("Attachment too large for a draft", 413);
      }
      await this.request(`/me/messages/${encodeURIComponent(draft.id)}/attachments`, {
        method: "POST",
        body: JSON.stringify({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: attachment.name,
          contentType: attachment.contentType,
          contentBytes: Buffer.from(attachment.content).toString("base64"),
        }),
      });
    }
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
