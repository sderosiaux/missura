import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHomes, initedHarness, type Harness } from "./harness.fixtures";
import { run } from "./index";
import { resolveHome } from "./paths";

/**
 * Written by the child, read by the test: the child's own view of its env.
 * It lands in MISSURA_HOME, which the child only knows because it inherited
 * it — which is itself part of what the first test asserts.
 */
const DUMP =
  'require("node:fs").writeFileSync(process.env.MISSURA_HOME + "/child-env.json", JSON.stringify(process.env))';

const ENTITIES = {
  "customer:acme": {
    "linear.customer": "c_18",
    "github.repos": ["acme-corp/product"],
  },
};

async function inited(env: Record<string, string> = {}): Promise<Harness> {
  const h = await initedHarness(env);
  writeFileSync(
    resolveHome(h.io.env).entitiesPath,
    JSON.stringify(ENTITIES),
    "utf8",
  );
  return h;
}

function childEnv(h: Harness): Record<string, string> {
  return JSON.parse(
    readFileSync(join(h.home, "child-env.json"), "utf8"),
  ) as Record<string, string>;
}

function execArgv(
  flags: readonly string[],
  script: string,
): readonly string[] {
  return ["exec", ...flags, "--", process.execPath, "-e", script];
}

afterEach(cleanupHomes);

describe("missura exec", () => {
  it("hands the child a mission token and never a vendor credential", async () => {
    const h = await inited({
      LINEAR_API_KEY: "lin_api_planted",
      GITHUB_TOKEN: "ghp_planted",
    });

    const result = await run(
      execArgv(
        ["--customer", "acme", "--purpose", "support case 42", "--ttl", "5m"],
        DUMP,
      ),
      h.io,
    );

    expect(result.code).toBe(0);
    const env = childEnv(h);
    expect(env.MISSION_TOKEN ?? "").toMatch(/^msr_/);
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.LINEAR_API_URL ?? "").toContain("/graphql");
    expect(env.GITHUB_API_URL ?? "").toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 30_000);

  it("forwards the child's exit code", async () => {
    const h = await inited();

    const result = await run(
      execArgv(["--customer", "acme", "--purpose", "p"], "process.exit(7)"),
      h.io,
    );

    expect(result.code).toBe(7);
  }, 30_000);

  it("revokes the mission once the child is gone", async () => {
    const h = await inited();

    await run(execArgv(["--customer", "acme", "--purpose", "p"], "0"), h.io);
    h.out.length = 0;
    const listed = await run(["missions"], h.io);

    expect(listed.code).toBe(0);
    expect(h.out.join("\n")).not.toMatch(/msn_/);
  }, 30_000);

  it("refuses a mission that names neither a customer nor a repo", async () => {
    const h = await inited();

    const result = await run(execArgv(["--purpose", "anything"], "0"), h.io);

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toMatch(/--customer|--repo/);
  });

  it("requires a purpose", async () => {
    const h = await inited();

    const result = await run(execArgv(["--customer", "acme"], "0"), h.io);

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toMatch(/purpose/);
  });

  it("refuses a ttl above the cap before spawning anything", async () => {
    const h = await inited();

    const result = await run(
      execArgv(
        ["--customer", "acme", "--purpose", "p", "--ttl", "999m"],
        "process.exit(3)",
      ),
      h.io,
    );

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toContain("3600");
  });

  it("refuses an unknown entity instead of minting an unscoped mission", async () => {
    const h = await inited();

    const result = await run(
      execArgv(["--customer", "globex", "--purpose", "p"], "0"),
      h.io,
    );

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toContain("unknown entity: customer:globex");
  });

  it("takes repeated --repo into the mission scope", async () => {
    const h = await inited();

    const result = await run(
      execArgv(
        [
          "--repo",
          "acme-corp/product",
          "--repo",
          "acme-corp/infra",
          "--purpose",
          "p",
        ],
        DUMP,
      ),
      h.io,
    );

    expect(result.code).toBe(0);
    const token = childEnv(h).MISSION_TOKEN ?? "";
    const payload = JSON.parse(
      Buffer.from(token.slice(4).split(".")[0] ?? "", "base64url").toString(
        "utf8",
      ),
    ) as { scope: { repos?: string[] }; connections: string[] };
    expect(payload.scope.repos).toEqual([
      "acme-corp/product",
      "acme-corp/infra",
    ]);
    expect(payload.connections).toEqual(["github"]);
  }, 30_000);

  /**
   * The whole point, at the surface a human touches: one shared repository, one
   * directory per customer, and a mission that reaches exactly one of them.
   * `/**` is the one sugar — a path prefix is recursive by definition, and the
   * suffix only says so out loud.
   */
  it("takes a path prefix on --repo, `/**` and all", async () => {
    const h = await inited();

    const result = await run(
      execArgv(
        [
          "--repo",
          "acme-corp/customer-data:granola-transcripts/abcam/**",
          "--purpose",
          "p",
        ],
        DUMP,
      ),
      h.io,
    );

    expect(result.code).toBe(0);
    const token = childEnv(h).MISSION_TOKEN ?? "";
    const payload = JSON.parse(
      Buffer.from(token.slice(4).split(".")[0] ?? "", "base64url").toString(
        "utf8",
      ),
    ) as { scope: { repos?: string[] }; connections: string[] };
    expect(payload.scope.repos).toEqual([
      "acme-corp/customer-data:granola-transcripts/abcam/**",
    ]);
    expect(payload.connections).toEqual(["github"]);
  }, 30_000);

  /**
   * Before a token exists, not at the first request it would have decided: a
   * scope spelling nobody can read must not become a mission at all.
   */
  it("refuses a --repo whose path prefix cannot be read, before minting", async () => {
    const h = await inited();

    const result = await run(
      execArgv(["--repo", "acme-corp/data:../escape", "--purpose", "p"], "0"),
      h.io,
    );

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toMatch(/path prefix/i);
  });

  it("refuses a glob dialect on --repo rather than guessing what it meant", async () => {
    const h = await inited();

    const result = await run(
      execArgv(["--repo", "acme-corp/data:granola/*", "--purpose", "p"], "0"),
      h.io,
    );

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toMatch(/glob/i);
  });
});
