import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

/**
 * A local Postgres without Docker: `pnpm dev:db`.
 * Data is kept in your user folder (outside OneDrive), so it survives restarts.
 * Stop it with Ctrl+C.
 */
const dir = path.join(process.env.LOCALAPPDATA ?? homedir(), "adminwise-dev-postgres");
const port = Number(process.env.DEV_DB_PORT ?? 5432);
const firstRun = !existsSync(path.join(dir, "PG_VERSION"));

const server = new EmbeddedPostgres({
  databaseDir: dir,
  user: "adminwise",
  password: "adminwise",
  port,
  persistent: true,
  onLog: () => {},
  onError: (message) => console.error(String(message)),
});

if (firstRun) await server.initialise();
await server.start();
if (firstRun) await server.createDatabase("adminwise");

console.log(`Postgres is running. Data folder: ${dir}`);
console.log(`DATABASE_URL=postgres://adminwise:adminwise@localhost:${port}/adminwise`);
console.log("Press Ctrl+C to stop.");

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
