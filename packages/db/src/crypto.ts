import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM encryption for mailbox tokens at rest.
 * Stored format: v1:<iv base64>:<auth tag base64>:<ciphertext base64>
 */
export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(stored: string, key: Buffer): string {
  const [version, iv, tag, data] = stored.split(":");
  if (version !== "v1" || !iv || !tag || data === undefined) {
    throw new Error("Unknown encrypted value format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/**
 * A signed, expiring token for links in our own emails (for example "never
 * follow up on this thread"). The payload is readable but cannot be changed:
 * it carries an HMAC made with a key derived from the encryption key.
 * Format: <payload base64url>.<signature base64url>
 */
function linkKey(key: Buffer): Buffer {
  return createHmac("sha256", key).update("adminwise-link-token-v1").digest();
}

export function signLinkToken(payload: Record<string, string>, expiresAt: Date, key: Buffer): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: expiresAt.getTime() })).toString("base64url");
  const signature = createHmac("sha256", linkKey(key)).update(body).digest("base64url");
  return `${body}.${signature}`;
}

/** Returns the payload, or null when the token was changed, is malformed or has expired. */
export function verifyLinkToken(token: string, key: Buffer, now: Date = new Date()): Record<string, string> | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", linkKey(key)).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { exp, ...payload } = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof exp !== "number" || exp < now.getTime()) return null;
    if (!Object.values(payload).every((v) => typeof v === "string")) return null;
    return payload as Record<string, string>;
  } catch {
    return null;
  }
}

/** One-way hash for sign-in and session tokens. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
