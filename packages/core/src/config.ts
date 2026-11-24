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
  /**
   * False (the default): every account has every feature and no trial ends.
   * True: trials end, plans are enforced and read-only accounts are deleted after 60 days.
   */
  billingEnabled: boolean;
  /** Null until a Stripe key is set: plans can then not be bought. */
  stripe: { secretKey: string; webhookSecret: string | null; automaticTax: boolean } | null;
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
  // Only the "eu." profiles keep a request inside the EU. "global." may process it anywhere in the
  // world, "us." in the United States, and a bare model id wherever AWS_REGION points.
  if (!id.startsWith("eu.")) {
    throw new Error(`${name} must be an EU inference profile, starting with "eu." (got ${id}).`);
  }
  return id;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appName = env.APP_NAME || "Adminwise";
  const region = env.AWS_REGION || "eu-central-1";
  if (!region.startsWith("eu-")) throw new Error(`AWS_REGION must be a region in the EU (got ${region}).`);
  // In production nothing falls back silently: without these, sign-in links would be printed into
  // the logs instead of mailed, and links in emails would point at localhost.
  if (env.NODE_ENV === "production" && env.ALLOW_INCOMPLETE_CONFIG !== "true") {
    required(env, "APP_BASE_URL");
    required(env, "POSTMARK_SERVER_TOKEN");
  }
  const concurrency = Number(env.WORKER_CONCURRENCY || 5);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) {
    throw new Error("WORKER_CONCURRENCY must be a whole number from 1 to 50");
  }
  const classify = euModel(env, "BEDROCK_MODEL_CLASSIFY", DEFAULT_MODEL_CLASSIFY);
  return {
    appName,
    appBaseUrl: (env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, ""),
    inboundDomain: (env.INBOUND_DOMAIN || "in.getadminwise.com").toLowerCase(),
    mailFrom: env.MAIL_FROM || `${appName} <hello@getadminwise.com>`,
    sellerCountry: (env.SELLER_COUNTRY || "PL").trim().toUpperCase(),
    billingEnabled: (env.BILLING_ENABLED || "").trim().toLowerCase() === "true",
    stripe: env.STRIPE_SECRET_KEY
      ? {
          secretKey: env.STRIPE_SECRET_KEY.trim(),
          webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
          automaticTax: (env.STRIPE_AUTOMATIC_TAX || "").trim().toLowerCase() === "true",
        }
      : null,
    databaseUrl: required(env, "DATABASE_URL"),
    tokenEncryptionKey: required(env, "TOKEN_ENCRYPTION_KEY"),
    aws: {
      region,
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
    workerConcurrency: concurrency,
  };
}
