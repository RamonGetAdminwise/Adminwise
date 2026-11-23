import { randomBytes } from "node:crypto";
import { createDb, sha256, system } from "../packages/db/src";
import { loadConfig } from "../packages/core/src/config";

/**
 * `pnpm tsx scripts/dev-session.ts`: LOCAL DEVELOPMENT ONLY. Creates an invented
 * customer in the local database and prints a session cookie for it, so a page
 * can be looked at without the sign-in email. Refuses to run against anything
 * but a database on localhost.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}

const config = loadConfig();
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl)) {
  console.error("Refused: DATABASE_URL is not a local database.");
  process.exit(1);
}
const db = createDb({ connectionString: config.databaseUrl, encryptionKey: config.tokenEncryptionKey, max: 1 });
const sys = system(db);
const tag = randomBytes(3).toString("hex");
const email = `owner.${tag}@nordpart.example`;
const { userId, customerId } = await sys.createCustomerWithUser({ email, slug: `nordpart-${tag}` });
const token = randomBytes(32).toString("base64url");
await sys.createSession(userId, customerId, sha256(token), new Date(Date.now() + 86_400_000));
await db.close();
console.log(`Signed in as ${email}. In the browser console on localhost run:`);
console.log(`document.cookie = "aw_session=${token}; path=/"`);
