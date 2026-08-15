import { loadOrCreateKey, MissionStore } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHomes, initedHarness, type Harness } from "./harness.fixtures";
import { run } from "./index";
import { resolveHome } from "./paths";

function seed(h: Harness): { id: string; token: string } {
  const paths = resolveHome(h.io.env);
  const store = new MissionStore(
    paths.missionsPath,
    loadOrCreateKey(paths.signingKeyPath),
  );
  const created = store.create(
    {
      purpose: "support case 42",
      actor: "ops@local",
      scope: { customer: "acme" },
      ttlSeconds: 600,
    },
    { linearCustomerId: "c_18", githubRepos: [] },
  );
  return { id: created.record.id, token: created.token };
}

afterEach(cleanupHomes);

describe("missura missions / revoke", () => {
  it("lists an active mission without any token material, then drops it once revoked", async () => {
    const h = await initedHarness();
    const { id, token } = seed(h);

    const listed = await run(["missions"], h.io);
    const table = h.out.join("\n");

    expect(listed.code).toBe(0);
    expect(table).toContain(id);
    expect(table).toContain("support case 42");
    expect(table).toContain("ops@local");
    expect(table).toContain("customer:acme");
    expect(table).not.toContain(token);
    expect(table).not.toContain("msr_");

    h.out.length = 0;
    const revoked = await run(["revoke", id], h.io);
    expect(revoked.code).toBe(0);
    expect(h.out.join("\n")).toContain(id);

    h.out.length = 0;
    await run(["missions"], h.io);
    expect(h.out.join("\n")).not.toContain(id);
  });

  it("says so plainly when nothing is active", async () => {
    const h = await initedHarness();

    const result = await run(["missions"], h.io);

    expect(result.code).toBe(0);
    expect(h.out.join("\n")).toMatch(/no active missions/i);
  });

  it("fails on an unknown mission id rather than pretending", async () => {
    const h = await initedHarness();

    const result = await run(["revoke", "msn_deadbeef"], h.io);

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toContain("msn_deadbeef");
  });

  it("requires a mission id", async () => {
    const h = await initedHarness();

    const result = await run(["revoke"], h.io);

    expect(result.code).toBe(1);
    expect(h.err.join("\n")).toMatch(/mission id/i);
  });
});

describe("missura token", () => {
  it("refuses without --dev and points at exec", async () => {
    const h = await initedHarness();

    const result = await run(["token"], h.io);

    expect(result.code).toBe(1);
    expect(h.out).toHaveLength(0);
    expect(h.err.join("\n")).toContain("--dev");
    expect(h.err.join("\n")).toContain("missura exec");
  });
});
