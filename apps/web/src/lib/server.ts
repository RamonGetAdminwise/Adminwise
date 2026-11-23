import "server-only";
import { createBedrockClient, WEB_PATIENCE, withPatience, type AiClient } from "@adminwise/ai";
import {
  createOutlookGateway,
  createStripeClient,
  loadConfig,
  startQueue,
  type Config,
  type OutlookGateway,
  type StartedQueue,
  type StripeClient,
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
    stripe?: StripeClient;
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
  // A person is waiting for the page: one more try when the model is busy, then an honest "try again".
  return (store.ai ??= withPatience(createBedrockClient(getConfig().aws), WEB_PATIENCE));
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

/** Null until a Stripe key is configured. */
export function getStripe(): StripeClient | null {
  const { stripe } = getConfig();
  if (!stripe) return null;
  return (store.stripe ??= createStripeClient(stripe));
}

export function getMicrosoftOAuth(): GraphOAuthConfig | null {
  const config = getConfig();
  if (!config.microsoft) return null;
  return { ...config.microsoft, redirectUri: `${config.appBaseUrl}/api/microsoft/callback` };
}
