import { existsSync, statSync } from "node:fs";
import { loadOrCreateKey, loadVault } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHomes,
  harness,
  GITHUB_TOKEN,
  LINEAR_KEY,
  type Harness,
} from "./harness.fixtures";
import { run, type CliResult } from "./index";
import { resolveHome } from "./paths";

async function init(h: Harness): Promise<CliResult> {
  return run(["init"], h.io);
}

afterEach(cleanupHomes);

describe("missura init", () => {
  it("writes vault + signing key from env and prints paths only, never values", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
    });

    const result = await init(h);

    const paths = resolveHome(h.io.env);
    expect(result.code).toBe(0);
    expect(existsSync(paths.vaultPath)).toBe(true);
    expect(existsSync(paths.signingKeyPath)).toBe(true);
    expect(existsSync(paths.operatorKeyPath)).toBe(true);
    expect(statSync(paths.operatorKeyPath).mode & 0o777).toBe(0o600);
    const printed = h.out.join("\n");
    expect(printed).toContain(paths.vaultPath);
    expect(printed).not.toContain(LINEAR_KEY);
    expect(printed).not.toContain(GITHUB_TOKEN);
  });

  it("refuses empty credentials and writes no vault", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: "   ",
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
    });

    const result = await init(h);

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toContain("linear");
    expect(existsSync(resolveHome(h.io.env).vaultPath)).toBe(false);
  });

  it("refuses to prompt when stdin is not a TTY and env is missing", async () => {
    const h = harness({ MISSURA_INIT_LINEAR_KEY: LINEAR_KEY });

    const result = await init(h);

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toContain("MISSURA_INIT_GITHUB_TOKEN");
    expect(existsSync(resolveHome(h.io.env).vaultPath)).toBe(false);
  });

  it("writes no zendesk connection when none of its three answers is given", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
    });

    expect((await init(h)).code).toBe(0);
    expect(h.out.join("\n")).toContain("zendesk     not configured");
    const vault = loadVault(
      resolveHome(h.io.env).vaultPath,
      loadOrCreateKey(resolveHome(h.io.env).vaultKeyPath),
    );
    expect(vault.zendesk).toBeUndefined();
  });

  /**
   * A connection an operator believes exists and does not would surface as
   * "not in your mission" on the one call the agent was minted for, so half an
   * answer is refused rather than dropped.
   */
  it("refuses half a zendesk connection and writes no vault", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
      MISSURA_INIT_ZENDESK_SUBDOMAIN: "acme",
      MISSURA_INIT_ZENDESK_EMAIL: "ops@acme.example",
    });

    const result = await init(h);

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toContain("MISSURA_INIT_ZENDESK_TOKEN");
    expect(existsSync(resolveHome(h.io.env).vaultPath)).toBe(false);
  });

  it("stores the zendesk origin and credential, and prints neither secret", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
      MISSURA_INIT_ZENDESK_SUBDOMAIN: "Acme",
      MISSURA_INIT_ZENDESK_EMAIL: "ops@acme.example",
      MISSURA_INIT_ZENDESK_TOKEN: "zd_secret",
    });

    expect((await init(h)).code).toBe(0);
    const paths = resolveHome(h.io.env);
    const vault = loadVault(paths.vaultPath, loadOrCreateKey(paths.vaultKeyPath));
    expect(vault["zendesk.base"]).toBe("https://acme.zendesk.com");
    // API token auth: `<email>/token:<token>`, HTTP Basic, assembled once here.
    expect(vault.zendesk).toBe(
      `Basic ${Buffer.from("ops@acme.example/token:zd_secret", "utf8").toString("base64")}`,
    );
    expect(h.out.join("\n")).not.toContain("zd_secret");
  });

  /** A URL here would let a typo aim a real credential at an unvetted host. */
  it("refuses anything but a bare subdomain", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
      MISSURA_INIT_ZENDESK_SUBDOMAIN: "https://acme.evil.test",
      MISSURA_INIT_ZENDESK_EMAIL: "ops@acme.example",
      MISSURA_INIT_ZENDESK_TOKEN: "zd_secret",
    });

    const result = await init(h);

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toMatch(/bare subdomain/i);
    expect(existsSync(resolveHome(h.io.env).vaultPath)).toBe(false);
  });
});

