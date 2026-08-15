import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Key size for both HMAC signing and AES-256-GCM vault encryption. */
export const KEY_BYTES = 32;

/** Owner-only file mode: key material must never be world- or group-readable. */
export const SECRET_FILE_MODE = 0o600;

/**
 * Loads the key at `path`, creating a fresh random one (mode 0600) if absent.
 * Never logs the key material.
 */
export function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `key file ${path} must hold exactly ${String(KEY_BYTES)} bytes`,
      );
    }
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, key, { mode: SECRET_FILE_MODE });
  return key;
}
