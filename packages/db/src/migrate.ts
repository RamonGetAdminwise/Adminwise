import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Applies every .sql file in migrations/ once, in name order. Safe to run on every start. */
export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    // Mail arrives in every language. A database that is not UTF-8 would refuse some of it
    // (a Polish Windows default cannot store Ukrainian), so we refuse to start on one.
    const encoding = (await client.query<{ server_encoding: string }>("SHOW server_encoding")).rows[0]?.server_encoding;
    if (encoding !== "UTF8") {
      throw new Error(
        `The database uses the text encoding ${encoding}, but UTF8 is required. Create the database with UTF8 encoding ` +
          "(for the local development database: delete its folder and start `pnpm dev:db` again).",
      );
    }
    // One migrator at a time, even when web and worker start together.
    await client.query("SELECT pg_advisory_lock(7411001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(7411001)").catch(() => undefined);
    await client.end();
  }
  return applied;
}
