import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateKey } from "./keys";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "missura-keys-"));
}

describe("key material", () => {
  it("creates a 32-byte key when the file is absent", () => {
    const path = join(tmpDir(), "signing.key");
    const key = loadOrCreateKey(path);
    expect(key.length).toBe(32);
  });

  it("reuses the key on a second load", () => {
    const path = join(tmpDir(), "signing.key");
    const first = loadOrCreateKey(path);
    const second = loadOrCreateKey(path);
    expect(second.equals(first)).toBe(true);
  });

  it("generates distinct keys for distinct paths", () => {
    const a = loadOrCreateKey(join(tmpDir(), "a.key"));
    const b = loadOrCreateKey(join(tmpDir(), "b.key"));
    expect(a.equals(b)).toBe(false);
  });

  it("creates missing parent directories", () => {
    const path = join(tmpDir(), "nested", "deeper", "signing.key");
    expect(loadOrCreateKey(path).length).toBe(32);
  });

  it.skipIf(process.platform === "win32")(
    "creates the key file with mode 0600",
    () => {
      const path = join(tmpDir(), "signing.key");
      loadOrCreateKey(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects an existing key file that is too short", () => {
    const path = join(tmpDir(), "short.key");
    writeFileSync(path, Buffer.alloc(8), { mode: 0o600 });
    expect(() => loadOrCreateKey(path)).toThrow(/32 bytes/i);
  });
});
