import { createDb, migrate, system } from "../packages/db/src";
import { loadConfig } from "../packages/core/src/config";

/**
 * `pnpm tsx scripts/dev-beat.ts [minutes ago]`: LOCAL DEVELOPMENT ONLY. Writes the
 * worker's sign of life into the local database without starting the worker, to
 * look at /api/status in both states. Refuses anything but a database on localhost.
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
await migrate(config.databaseUrl);
const db = createDb({ connectionString: config.databaseUrl, encryptionKey: config.tokenEncryptionKey, max: 1 });
const minutesAgo = Number(process.argv[2] ?? 0);
// eslint-disable-next-line no-restricted-syntax -- local helper: sets the one heartbeat row to an exact moment, also backwards
await db.pool.query(
  "INSERT INTO heartbeats (name, beat_at) VALUES ('worker', now() - make_interval(mins => $1)) ON CONFLICT (name) DO UPDATE SET beat_at = EXCLUDED.beat_at",
  [minutesAgo],
);
console.log(`worker heartbeat set to ${minutesAgo} minute(s) ago: ${(await system(db).lastBeat("worker"))?.toISOString()}`);
await db.close();
