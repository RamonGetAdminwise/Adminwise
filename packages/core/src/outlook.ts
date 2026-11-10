import { randomBytes } from "node:crypto";
import type { CustomerScope, MailboxConnection } from "@adminwise/db";
import { GraphAuthError, GraphClient, refreshTokens, type GraphOAuthConfig, type InboundMessage } from "@adminwise/mail";

/**
 * Everything the jobs need from a customer's Microsoft 365 mailbox.
 * The gateway owns token handling: it refreshes access tokens before they
 * expire and, when Microsoft says the sign-in is no longer valid, marks the
 * connection "needs_reconnect" so the daily brief can show a reconnect link.
 */
export interface OutlookGateway {
  fetchMessage(scope: CustomerScope, connectionId: string, providerMessageId: string): Promise<InboundMessage>;
  /**
   * Ids of messages that arrived since the last poll, plus the bookmark to
   * store (scope.markSynced) once those messages have been taken in.
   */
  listNewMessageIds(scope: CustomerScope, connectionId: string): Promise<{ messageIds: string[]; deltaLink: string }>;
  /** Writes a reply into the Drafts folder. Returns the draft's id. Never sends. */
  createReplyDraft(scope: CustomerScope, connectionId: string, providerMessageId: string, text: string): Promise<string>;
  /** Creates or renews the change-notification subscription. */
  ensureSubscription(scope: CustomerScope, connectionId: string): Promise<void>;
}

export class ConnectionUnavailableError extends Error {
  constructor(status: string) {
    super(`Mailbox connection is ${status}`);
    this.name = "ConnectionUnavailableError";
  }
}

const REFRESH_MARGIN_MS = 5 * 60_000;
const RENEW_MARGIN_MS = 24 * 3_600_000;

export function createOutlookGateway(options: {
  oauth: GraphOAuthConfig;
  /** Public https URL of /api/webhooks/graph, or null to rely on polling only (local development). */
  notificationUrl: string | null;
}): OutlookGateway {
  const doFetch = options.oauth.fetch ?? fetch;

  async function refresh(scope: CustomerScope, connection: MailboxConnection): Promise<string> {
    if (!connection.refreshToken) throw new ConnectionUnavailableError("missing a refresh token");
    try {
      const tokens = await refreshTokens(options.oauth, connection.refreshToken);
      await scope.updateConnectionTokens(connection.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
      });
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof GraphAuthError) {
        await scope.setConnectionStatus(connection.id, "needs_reconnect", error.code);
        await scope.audit("mailbox.needs_reconnect", { connectionId: connection.id, reason: error.code });
      }
      throw error;
    }
  }

  async function withClient<T>(
    scope: CustomerScope,
    connectionId: string,
    fn: (client: GraphClient, connection: MailboxConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await scope.getConnection(connectionId);
    if (!connection) throw new ConnectionUnavailableError("not found");
    if (connection.status !== "active") throw new ConnectionUnavailableError(connection.status);

    const expiresSoon =
      !connection.tokenExpiresAt || connection.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
    let accessToken = connection.accessToken;
    if (!accessToken || expiresSoon) accessToken = await refresh(scope, connection);

    try {
      return await fn(new GraphClient(accessToken, doFetch), connection);
    } catch (error) {
      if (!(error instanceof GraphAuthError)) throw error;
      // The token was rejected early: refresh once and try again.
      accessToken = await refresh(scope, connection);
      return fn(new GraphClient(accessToken, doFetch), connection);
    }
  }

  return {
    fetchMessage: (scope, connectionId, providerMessageId) =>
      withClient(scope, connectionId, (client) => client.getMessage(providerMessageId)),

    listNewMessageIds: (scope, connectionId) =>
      withClient(scope, connectionId, (client, connection) =>
        client.listInboxDelta({ deltaLink: connection.deltaLink, since: connection.createdAt }),
      ),

    createReplyDraft: (scope, connectionId, providerMessageId, text) =>
      withClient(scope, connectionId, (client) => client.createReplyDraft(providerMessageId, text)),

    ensureSubscription: (scope, connectionId) =>
      withClient(scope, connectionId, async (client, connection) => {
        if (!options.notificationUrl) return;
        const expiresAt = connection.subscriptionExpiresAt?.getTime() ?? 0;
        if (connection.subscriptionId && expiresAt - Date.now() > RENEW_MARGIN_MS) return;
        if (connection.subscriptionId && connection.clientState && expiresAt > Date.now()) {
          const renewed = await client.renewSubscription(connection.subscriptionId);
          await scope.setSubscription(connectionId, {
            subscriptionId: connection.subscriptionId,
            expiresAt: renewed,
            clientState: connection.clientState,
          });
          return;
        }
        const clientState = randomBytes(24).toString("hex");
        const created = await client.createSubscription(options.notificationUrl, clientState);
        await scope.setSubscription(connectionId, {
          subscriptionId: created.id,
          expiresAt: created.expiresAt,
          clientState,
        });
      }),
  };
}
