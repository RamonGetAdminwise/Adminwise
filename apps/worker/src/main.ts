import { createBedrockClient } from "@adminwise/ai";
import { createOutlookGateway, loadConfig, startQueue } from "@adminwise/core";
import { createDb, migrate } from "@adminwise/db";
import { ConsoleMailer, PostmarkMailer } from "@adminwise/mail";
import type { Deps } from "./deps";
import { createPdfRenderer } from "./pdf";
import { registerSchedules, registerWorkers } from "./register";

/** The worker process: runs every background job. Start with `pnpm dev:worker`. */
const config = loadConfig();

const applied = await migrate(config.databaseUrl);
if (applied.length) console.log(`[worker] applied migrations: ${applied.join(", ")}`);

const db = createDb({ connectionString: config.databaseUrl, encryptionKey: config.tokenEncryptionKey });
const queue = await startQueue(config.databaseUrl, "worker");

const pdf = createPdfRenderer();
const isPublic = config.appBaseUrl.startsWith("https://");
const deps: Deps = {
  db,
  queue,
  ai: createBedrockClient(config.aws),
  mailer: config.postmark.serverToken
    ? new PostmarkMailer({ serverToken: config.postmark.serverToken, from: config.mailFrom })
    : new ConsoleMailer(),
  outlook: createOutlookGateway({
    oauth: {
      clientId: config.microsoft?.clientId ?? "",
      clientSecret: config.microsoft?.clientSecret ?? "",
      tenant: config.microsoft?.tenant ?? "common",
      redirectUri: `${config.appBaseUrl}/api/microsoft/callback`,
    },
    // Microsoft only delivers notifications to a public https address; locally we rely on polling.
    notificationUrl: isPublic ? `${config.appBaseUrl}/api/webhooks/graph` : null,
  }),
  pdf,
  appName: config.appName,
  appBaseUrl: config.appBaseUrl,
  alertEmail: config.alertEmail,
};

await registerWorkers(queue.boss, deps, config.workerConcurrency);
await registerSchedules(queue.boss);
console.log(`[worker] running (drafts: ${config.aws.models.default}, classification: ${config.aws.models.classify}, region ${config.aws.region})`);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal}: finishing current jobs`);
  await queue.stop();
  await pdf.close();
  await db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
