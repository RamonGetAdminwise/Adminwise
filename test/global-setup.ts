import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { migrate } from "../packages/db/src/migrate";

/**
 * Gives the tests a real Postgres.
 * - If TEST_DATABASE_URL is set (CI, or docker compose locally) that database is used.
 * - Otherwise a throw-away Postgres is started from the embedded-postgres
 *   package, in the system temp folder, and removed afterwards. No Docker needed.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop = async () => {};

  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = await mkdtemp(path.join(tmpdir(), "bo-test-pg-"));
    const port = await freePort();
    const server = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await server.initialise();
    await server.start();
    await server.createDatabase("bo_test");
    url = `postgres://postgres:postgres@127.0.0.1:${port}/bo_test`;
    stop = async () => {
      await server.stop();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
  }

  await migrate(url);
  project.provide("databaseUrl", url);
  return stop;
}
