/**
 * All configuration comes from environment variables (see .env.example).
 * Nothing here is Railway-specific: any host that can set env vars works.
 */
export interface Config {
  appName: string;
  /** Public address of the web app, no trailing slash. */
  appBaseUrl: string;
  /** Forwarding addresses are <slug>@<inboundDomain>. */
  inboundDomain: string;
  mailFrom: string;
  /** ISO code of the country our own invoices are issued from; decides when VAT is reverse-charged. */
  sellerCountry: string;
  databaseUrl: string;
  tokenEncryptionKey: string;
  /**
   * `models.default` writes (drafts, follow-ups, voice profile, later quotes);
   * `models.classify` sorts (mail, "does this expect a reply?", document types).
   * The other keys are job names that use the sorting model.
   */
  aws: { region: string; models: { default: string; classify: string } & Record<string, string> };
  /** Where operator alerts go (job failures, stuck queue). Null = no alerts. */
  alertEmail: string | null;
  microsoft: { clientId: string; clientSecret: string; tenant: string } | null;
  postmark: { serverToken: string | null; inboundSecret: string | null };
  workerConcurrency: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

/** EU inference profiles on Bedrock: sent to AWS_REGION, served only from EU regions. */
export const DEFAULT_MODEL_DRAFT = "eu.anthropic.claude-sonnet-4-6";
export const DEFAULT_MODEL_CLASSIFY = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

function euModel(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const id = (env[name] || fallback).trim();
  // The "global." profiles may process a request in any region worldwide. That breaks the EU promise.
  if (id.startsWith("global.")) {
    throw new Error(`${name} must not use a global inference profile (${id}). Use the "eu." profile instead.`);
  }
  return id;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appName = env.APP_NAME || "Adminwise";
  const classify = euModel(env, "BEDROCK_MODEL_CLASSIFY", DEFAULT_MODEL_CLASSIFY);
  return {
    appName,
    appBaseUrl: (env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, ""),
    inboundDomain: (env.INBOUND_DOMAIN || "in.getadminwise.com").toLowerCase(),
    mailFrom: env.MAIL_FROM || `${appName} <hello@getadminwise.com>`,
    sellerCountry: (env.SELLER_COUNTRY || "PL").trim().toUpperCase(),
    databaseUrl: required(env, "DATABASE_URL"),
    tokenEncryptionKey: required(env, "TOKEN_ENCRYPTION_KEY"),
    aws: {
      region: env.AWS_REGION || "eu-central-1",
      models: {
        default: euModel(env, "BEDROCK_MODEL_DRAFT", DEFAULT_MODEL_DRAFT),
        classify,
        "chaser-check": classify,
        "file-type": classify,
        "price-list-columns": classify,
        "offer-acceptance": classify,
        "payment-notice": classify,
      },
    },
    alertEmail: env.ALERT_EMAIL?.trim() || null,
    microsoft:
      env.MS_CLIENT_ID && env.MS_CLIENT_SECRET
        ? { clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET, tenant: env.MS_TENANT || "common" }
        : null,
    postmark: {
      serverToken: env.POSTMARK_SERVER_TOKEN || null,
      inboundSecret: env.POSTMARK_INBOUND_SECRET || null,
    },
    workerConcurrency: Number(env.WORKER_CONCURRENCY || 5),
  };
}
