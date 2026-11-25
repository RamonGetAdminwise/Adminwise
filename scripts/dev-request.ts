import { randomBytes } from "node:crypto";
import { createDb, sha256, signLinkToken, system } from "../packages/db/src";
import { loadConfig } from "../packages/core/src/config";

/**
 * `pnpm tsx scripts/dev-request.ts <email>`: LOCAL DEVELOPMENT ONLY. For the request for access
 * sent from that address on the local site, prints the link the owner would get by mail (approve
 * or decline) and a sign-in link for the address, so the whole way in can be walked through
 * without a mailbox. Refuses to run against anything but a database on localhost.
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
const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) {
  console.error("Give the email address of the request.");
  process.exit(1);
}
const db = createDb({ connectionString: config.databaseUrl, encryptionKey: config.tokenEncryptionKey, max: 1 });
const sys = system(db);
const request = await sys.findAccessRequest(email);
if (!request) {
  console.log(`No request from ${email}.`);
} else {
  const token = signLinkToken({ r: request.id }, new Date(Date.now() + 86_400_000), db.encryptionKey);
  console.log(`Request from ${request.company}: ${request.status}`);
  console.log(`Decide: ${config.appBaseUrl}/request/decide?token=${token}`);
}
const login = randomBytes(32).toString("base64url");
await sys.createLoginToken(email, sha256(login), new Date(Date.now() + 15 * 60_000));
console.log(`Sign in: ${config.appBaseUrl}/auth/verify?token=${login}`);
await db.close();
