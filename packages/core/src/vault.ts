import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KEY_BYTES, SECRET_FILE_MODE } from "./keys";

/**
 * Vendor credentials keyed by connection name, e.g. `{ linear: "lin_api_..." }`.
 * A `Record` rather than an index-signature interface: same shape, lint-clean.
 */
export type VaultData = Record<string, string>;

interface VaultFile {
  iv: string;
  tag: string;
  data: string;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`vault key must be exactly ${String(KEY_BYTES)} bytes`);
  }
}

function isVaultFile(value: unknown): value is VaultFile {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.iv === "string" &&
    typeof f.tag === "string" &&
    typeof f.data === "string"
  );
}

/** Encrypts `data` with AES-256-GCM under a fresh IV and writes it mode 0600. */
export function saveVault(path: string, key: Buffer, data: VaultData): void {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);
  const file: VaultFile = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(file), { mode: SECRET_FILE_MODE });
}

/**
 * Decrypts the vault at `path`. Fails closed: a wrong key or tampered file
 * throws instead of yielding partial or garbage credentials.
 */
export function loadVault(path: string, key: Buffer): VaultData {
  assertKey(key);
  if (!existsSync(path)) throw new Error("vault not found — run missura init");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("vault decrypt failed: unreadable vault file");
  }
  if (!isVaultFile(parsed)) {
    throw new Error("vault decrypt failed: malformed vault file");
  }
  let plaintext: string;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(parsed.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
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
