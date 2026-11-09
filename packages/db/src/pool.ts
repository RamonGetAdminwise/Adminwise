import pg from "pg";
import { parseEncryptionKey } from "./crypto";

export interface Db {
  pool: pg.Pool;
  encryptionKey: Buffer;
  close(): Promise<void>;
}

export function createDb(options: { connectionString: string; encryptionKey: string; max?: number }): Db {
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  return {
    pool,
    encryptionKey: parseEncryptionKey(options.encryptionKey),
    close: () => pool.end(),
  };
}

/** snake_case row -> camelCase object. */
export function camel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out as T;
}
