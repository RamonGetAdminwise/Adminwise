import "server-only";
import { createBedrockClient, type AiClient } from "@adminwise/ai";
import {
  createOutlookGateway,
  loadConfig,
  startQueue,
  type Config,
  type OutlookGateway,
  type StartedQueue,
} from "@adminwise/core";
import { createDb, type Db } from "@adminwise/db";
import { ConsoleMailer, PostmarkMailer, type GraphOAuthConfig, type OutboundMailer } from "@adminwise/mail";

/**
 * Server-side singletons for the web app. Kept on globalThis so that Next's
 * hot reload in development does not open a new database pool on every edit.
 */
const cache = globalThis as unknown as {
  __adminwise?: {
    config?: Config;
    db?: Db;
    queue?: Promise<StartedQueue>;
    ai?: AiClient;
    mailer?: OutboundMailer;
    outlook?: OutlookGateway;
  };
};
const store = (cache.__adminwise ??= {});

export function getConfig(): Config {
  return (store.config ??= loadConfig());
}

export function getDb(): Db {
  const config = getConfig();
  return (store.db ??= createDb({
    connectionString: config.databaseUrl,
    encryptionKey: config.tokenEncryptionKey,
    max: 5,
  }));
}

/** The web app only hands jobs to the worker; it never runs them. */
export function getQueue(): Promise<StartedQueue> {
  return (store.queue ??= startQueue(getConfig().databaseUrl, "web"));
}

export function getAi(): AiClient {
  return (store.ai ??= createBedrockClient(getConfig().aws));
}

export function getMailer(): OutboundMailer {
  const config = getConfig();
  return (store.mailer ??= config.postmark.serverToken
    ? new PostmarkMailer({ serverToken: config.postmark.serverToken, from: config.mailFrom })
    : new ConsoleMailer());
}

/** The customer's mailbox, for the few things the web app does there itself (removing a follow-up draft we created). */
export function getOutlook(): OutlookGateway | null {
  const oauth = getMicrosoftOAuth();
  if (!oauth) return null;
  return (store.outlook ??= createOutlookGateway({ oauth, notificationUrl: null }));
}

export function getMicrosoftOAuth(): GraphOAuthConfig | null {
  const config = getConfig();
  if (!config.microsoft) return null;
  return { ...config.microsoft, redirectUri: `${config.appBaseUrl}/api/microsoft/callback` };
}
