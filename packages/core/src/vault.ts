import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SECRET_FILE_MODE } from "./keys";
import { assertSealKey, isSealedText, seal, unseal } from "./seal";

/**
 * Vendor credentials keyed by connection name, e.g. `{ linear: "lin_api_..." }`.
 * A `Record` rather than an index-signature interface: same shape, lint-clean.
 */
export type VaultData = Record<string, string>;

/** Encrypts `data` (`seal.ts`) under a fresh IV and writes it mode 0600. */
export function saveVault(path: string, key: Buffer, data: VaultData): void {
  assertSealKey(key);
  const file = seal(key, JSON.stringify(data));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(file), { mode: SECRET_FILE_MODE });
}

/**
 * Decrypts the vault at `path`. Fails closed: a wrong key or tampered file
 * throws instead of yielding partial or garbage credentials.
 */
export function loadVault(path: string, key: Buffer): VaultData {
  assertSealKey(key);
  if (!existsSync(path)) throw new Error("vault not found — run missura init");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("vault decrypt failed: unreadable vault file");
  }
  if (!isSealedText(parsed)) {
    throw new Error("vault decrypt failed: malformed vault file");
  }
  let plaintext: string;
  try {
    plaintext = unseal(key, parsed);
  } catch {
    throw new Error("vault decrypt failed: wrong key or corrupted vault");
  }
  let data: unknown;
  try {
    data = JSON.parse(plaintext);
  } catch {
    throw new Error("vault decrypt failed: malformed vault contents");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("vault decrypt failed: malformed vault contents");
  }
  for (const value of Object.values(data)) {
    if (typeof value !== "string") {
      throw new Error("vault decrypt failed: malformed vault contents");
    }
  }
  return data as VaultData;
}
