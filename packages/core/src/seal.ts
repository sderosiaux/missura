import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KEY_BYTES } from "./keys";

/**
 * THE ONE ENCRYPTION PRIMITIVE: AES-256-GCM under a fresh IV, authenticated.
 * The vault has always used it for vendor credentials; approval bodies at
 * rest (M3) use the same function under the same key. Nothing else in this
 * codebase encrypts, and nothing here chooses a mode, a nonce size or a key
 * size — those are fixed once, below.
 */

export interface SealedText {
  iv: string;
  tag: string;
  data: string;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export function assertSealKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`seal key must be exactly ${String(KEY_BYTES)} bytes`);
  }
}

export function isSealedText(value: unknown): value is SealedText {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return typeof f.iv === "string" && typeof f.tag === "string" && typeof f.data === "string";
}

export function seal(key: Buffer, plaintext: string): SealedText {
  assertSealKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

/** Fails closed: a wrong key or a tampered text throws, never yields garbage. */
export function unseal(key: Buffer, sealed: SealedText): string {
  assertSealKey(key);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("decrypt failed: wrong key or corrupted data");
  }
}
