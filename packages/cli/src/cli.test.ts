import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadOrCreateKey, verifyMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { run, type CliIo, type CliResult } from "./index";
import { resolveHome } from "./paths";

const execFileAsync = promisify(execFile);

const LINEAR_KEY = "lin_api_test_key";
const GITHUB_TOKEN = "ghp_test_token";

interface Harness {
  io: CliIo;
  out: string[];
  err: string[];
  home: string;
}

const homes: string[] = [];

function harness(env: Record<string, string> = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "missura-cli-"));
  homes.push(home);
  const out: string[] = [];
  const err: string[] = [];
  return {
    home,
    out,
    err,
    io: {
      env: { MISSURA_HOME: home, ...env },
      stdout: (line): void => {
        out.push(line);
      },
      stderr: (line): void => {
        err.push(line);
      },
      isTTY: false,
      prompt: (): Promise<string> => {
        throw new Error("prompt must not be called in these tests");
      },
    },
  };
}

async function init(h: Harness): Promise<CliResult> {
  return run(["init"], h.io);
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

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
});

describe("missura token", () => {
  it("prints only a token, verifiable with the stored signing key", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
    });
    await init(h);
    h.out.length = 0;

    const result = await run(["token", "--ttl", "60"], h.io);

    expect(result.code).toBe(0);
    expect(h.out).toHaveLength(1);
    const token = h.out[0] ?? "";
    const key = loadOrCreateKey(resolveHome(h.io.env).signingKeyPath);
    const claims = verifyMissionToken(token, { key });
    expect(claims.connections).toContain("linear");
    expect(claims.exp - claims.iat).toBe(60);
  });
});

describe("missura run", () => {
  it("fails with a clear message when the vault is missing", async () => {
    const h = harness();

    const result = await run(["run"], h.io);

    expect(result.code).toBe(1);
    expect(result.servers).toBeUndefined();
    expect(h.err.join("\n")).toContain("missura init");
  });

  it("boots both listeners and denies a tokenless request with 401", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
    });
    await init(h);
    h.out.length = 0;

    const result = await run(
      ["run", "--linear-port", "0", "--github-port", "0"],
      h.io,
    );
    expect(result.code).toBe(0);
    const servers = result.servers;
    if (servers === undefined) throw new Error("expected servers");

    try {
      const { port } = servers.linear.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(port)}/graphql`, {
        method: "POST",
        body: JSON.stringify({ query: "{ viewer { id } }" }),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: "missura_unauthorized" },
      });
      expect(h.out.join("\n")).toContain("DENY");

      const eventsDir = resolveHome(h.io.env).eventsDir;
      const files = readdirSync(eventsDir);
      const first = files[0];
      if (first === undefined) throw new Error("expected an event file");
      const logged: unknown = JSON.parse(
        (readFileSync(join(eventsDir, first), "utf8").split("\n")[0] ?? ""),
      );
      expect(logged).toMatchObject({ provider: "linear", decision: "deny" });
      expect(JSON.stringify(logged)).not.toContain(LINEAR_KEY);
    } finally {
      await servers.close();
    }
  });
});

describe("missura bin", () => {
  it("runs through the shebang entry point", async () => {
    const h = harness({
      MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
      MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
    });
    await init(h);

    const { stdout } = await execFileAsync(
      join(import.meta.dirname, "..", "node_modules", ".bin", "tsx"),
      [join(import.meta.dirname, "cli.ts"), "token"],
      { env: { ...process.env, MISSURA_HOME: h.home } },
    );

    const key = loadOrCreateKey(resolveHome(h.io.env).signingKeyPath);
    expect(() => verifyMissionToken(stdout.trim(), { key })).not.toThrow();
  }, 30_000);
});
