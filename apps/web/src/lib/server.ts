import "server-only";
import { createBedrockClient, type AiClient } from "@bo/ai";
import { loadConfig, startQueue, type Config, type StartedQueue } from "@bo/core";
import { createDb, type Db } from "@bo/db";
import { ConsoleMailer, PostmarkMailer, type GraphOAuthConfig, type OutboundMailer } from "@bo/mail";

/**
 * Server-side singletons for the web app. Kept on globalThis so that Next's
 * hot reload in development does not open a new database pool on every edit.
 */
const cache = globalThis as unknown as {
  __bo?: { config?: Config; db?: Db; queue?: Promise<StartedQueue>; ai?: AiClient; mailer?: OutboundMailer };
};
const store = (cache.__bo ??= {});

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
  const { aws } = getConfig();
  return (store.ai ??= createBedrockClient({ region: aws.region, modelId: aws.modelId }));
}

export function getMailer(): OutboundMailer {
  const config = getConfig();
  return (store.mailer ??= config.postmark.serverToken
    ? new PostmarkMailer({ serverToken: config.postmark.serverToken, from: config.mailFrom })
    : new ConsoleMailer());
}

export function getMicrosoftOAuth(): GraphOAuthConfig | null {
  const config = getConfig();
  if (!config.microsoft) return null;
  return { ...config.microsoft, redirectUri: `${config.appBaseUrl}/api/microsoft/callback` };
}
