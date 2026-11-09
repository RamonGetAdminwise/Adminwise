import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, parseEncryptionKey, sha256 } from "../src/crypto";

describe("token encryption", () => {
  const key = parseEncryptionKey(randomBytes(32).toString("base64"));

  it("round-trips and never stores the plain value", () => {
    const stored = encrypt("refresh-token-value", key);
    expect(stored).not.toContain("refresh-token-value");
    expect(decrypt(stored, key)).toBe("refresh-token-value");
    expect(encrypt("refresh-token-value", key)).not.toBe(stored); // fresh IV every time
  });

  it("refuses a wrong key, a tampered value and a short key", () => {
    const stored = encrypt("secret", key);
    expect(() => decrypt(stored, parseEncryptionKey(randomBytes(32).toString("base64")))).toThrow();
    expect(() => decrypt(stored.slice(0, -4) + "AAAA", key)).toThrow();
    expect(() => parseEncryptionKey("c2hvcnQ=")).toThrow(/32 bytes/);
  });

  it("hashes sign-in tokens one way", () => {
    expect(sha256("abc")).toHaveLength(64);
    expect(sha256("abc")).not.toContain("abc");
  });
});
