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
  databaseUrl: string;
  tokenEncryptionKey: string;
  aws: { region: string; modelId: string };
  microsoft: { clientId: string; clientSecret: string; tenant: string } | null;
  postmark: { serverToken: string | null; inboundSecret: string | null };
  workerConcurrency: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appName = env.APP_NAME || "Backoffice";
  return {
    appName,
    appBaseUrl: (env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, ""),
    inboundDomain: (env.INBOUND_DOMAIN || "in.backoffice.example").toLowerCase(),
    mailFrom: env.MAIL_FROM || `${appName} <hello@backoffice.example>`,
    databaseUrl: required(env, "DATABASE_URL"),
    tokenEncryptionKey: required(env, "TOKEN_ENCRYPTION_KEY"),
    aws: {
      region: env.AWS_REGION || "eu-central-1",
      modelId: env.BEDROCK_MODEL_ID || "anthropic.claude-opus-5-5",
    },
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
