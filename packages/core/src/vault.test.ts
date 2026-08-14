import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVault, saveVault, type VaultData } from "./vault";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const DATA: VaultData = { linear: "lin_api_secret", github: "ghp_secret" };

function vaultPath(): string {
  return join(mkdtempSync(join(tmpdir(), "missura-vault-")), "vault.json");
}

describe("encrypted vault", () => {
  it("round-trips saved data", () => {
    const path = vaultPath();
    saveVault(path, KEY, DATA);
    expect(loadVault(path, KEY)).toEqual(DATA);
  });

  it("throws on a wrong key instead of returning garbage", () => {
    const path = vaultPath();
    saveVault(path, KEY, DATA);
    expect(() => loadVault(path, OTHER_KEY)).toThrow(/decrypt/i);
  });

  it("throws when the ciphertext is tampered with", () => {
    const path = vaultPath();
    saveVault(path, KEY, DATA);
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      iv: string;
      tag: string;
      data: string;
    };
    const bytes = Buffer.from(file.data, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(
      path,
      JSON.stringify({ ...file, data: bytes.toString("base64") }),
    );
    expect(() => loadVault(path, KEY)).toThrow(/decrypt/i);
  });

  it("uses a fresh IV per save, so ciphertexts differ for identical data", () => {
    const a = vaultPath();
    const b = vaultPath();
    saveVault(a, KEY, DATA);
    saveVault(b, KEY, DATA);
    const first = JSON.parse(readFileSync(a, "utf8")) as Record<string, string>;
    const second = JSON.parse(readFileSync(b, "utf8")) as Record<string, string>;
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it("never writes the plaintext secret to disk", () => {
    const path = vaultPath();
    saveVault(path, KEY, DATA);
    expect(readFileSync(path, "utf8")).not.toContain("lin_api_secret");
  });

  it.skipIf(process.platform === "win32")(
    "creates the vault file with mode 0600",
    (): void => {
      const path = vaultPath();
      saveVault(path, KEY, DATA);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("reports a clear error when the vault is missing", () => {
    expect(() => loadVault(vaultPath(), KEY)).toThrow(
      "vault not found — run missura init",
    );
  });

  it("rejects a key that is not 32 bytes", () => {
    expect((): void => {
      saveVault(vaultPath(), Buffer.alloc(16), DATA);
    }).toThrow(
      /32 bytes/i,
    );
  });
});
