import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedScope } from "./entities";
import { MissionStore, type CreateMission } from "./missions";
import { verifyMissionToken } from "./token";

const KEY = Buffer.alloc(32, 3);

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "missura-missions-")), "state.json");
}

const INPUT: CreateMission = {
  purpose: "support case 482",
  actor: "sam@acme.io",
  scope: { customer: "acme", repos: ["acme-corp/product"] },
  ttlSeconds: 900,
};

const RESOLVED: ResolvedScope = {
  linearCustomerId: "c_18",
  githubRepos: [{ repo: "acme-corp/product" }],
};

describe("mission store — create", () => {
  it("mints a token carrying actor, purpose and scope", () => {
    const store = new MissionStore(statePath(), KEY);
    const { record, token } = store.create(INPUT, RESOLVED);
    const claims = verifyMissionToken(token, { key: KEY });

    expect(claims.actor).toBe("sam@acme.io");
    expect(claims.purpose).toBe("support case 482");
    expect(claims.scope).toEqual({
      customer: "acme",
      repos: ["acme-corp/product"],
    });
    expect(claims.id).toBe(record.id);
    expect(claims.jti).toBe(record.jti);
    expect(record.expiresAt - record.createdAt).toBe(900);
  });

  it("derives both connections when the scope has a customer and repos", () => {
    const store = new MissionStore(statePath(), KEY);
    const { token } = store.create(INPUT, RESOLVED);
    expect(verifyMissionToken(token, { key: KEY }).connections).toEqual([
      "linear",
      "github",
    ]);
  });

  it("derives linear only when the scope resolves to a customer and no repo", () => {
    const store = new MissionStore(statePath(), KEY);
    const { token } = store.create(
      { ...INPUT, scope: { customer: "acme" } },
      { linearCustomerId: "c_18", githubRepos: [] },
    );
    expect(verifyMissionToken(token, { key: KEY }).connections).toEqual([
      "linear",
    ]);
  });

  it("derives github only when the scope resolves to repos and no customer", () => {
    const store = new MissionStore(statePath(), KEY);
    const { token } = store.create(
      { ...INPUT, scope: { repos: ["acme-corp/product"] } },
      { githubRepos: [{ repo: "acme-corp/product" }] },
    );
    expect(verifyMissionToken(token, { key: KEY }).connections).toEqual([
      "github",
    ]);
  });

  it("derives github for a customer-only scope whose entity carries repos", () => {
    // The business scope names no repo; the entity map does. Derived from the
    // scope as typed, this mission would carry `linear` alone and refuse every
    // GitHub call on the connection check.
    const store = new MissionStore(statePath(), KEY);
    const { token } = store.create(
      { ...INPUT, scope: { customer: "acme" } },
      RESOLVED,
    );
    expect(verifyMissionToken(token, { key: KEY }).connections).toEqual([
      "linear",
      "github",
    ]);
  });

  it("derives no connection from a scope that resolves to nothing", () => {
    const store = new MissionStore(statePath(), KEY);
    const { token } = store.create(
      { ...INPUT, scope: {} },
      { githubRepos: [] },
    );
    expect(verifyMissionToken(token, { key: KEY }).connections).toEqual([]);
  });

  it("rejects an empty or blank purpose", () => {
    const store = new MissionStore(statePath(), KEY);
    expect(() =>
      store.create({ ...INPUT, purpose: "" }, RESOLVED),
    ).toThrow(/purpose/i);
    expect(() => store.create({ ...INPUT, purpose: "   " }, RESOLVED)).toThrow(
      /purpose/i,
    );
  });

  it("rejects an empty or blank actor", () => {
    const store = new MissionStore(statePath(), KEY);
    expect(() =>
      store.create({ ...INPUT, actor: "" }, RESOLVED),
    ).toThrow(/actor/i);
    expect(() =>
      store.create({ ...INPUT, actor: "  " }, RESOLVED),
    ).toThrow(/actor/i);
  });

  it("rejects a ttl above the 60 minute cap and stores nothing", () => {
    const store = new MissionStore(statePath(), KEY);
    expect(() =>
      store.create({ ...INPUT, ttlSeconds: 3601 }, RESOLVED),
    ).toThrow(/ttl/i);
    expect(store.active()).toHaveLength(0);
  });

  it("never writes token material to the state file", () => {
    const path = statePath();
    const store = new MissionStore(path, KEY);
    const { token } = store.create(INPUT, RESOLVED);
    expect(readFileSync(path, "utf8")).not.toContain(token);
  });
});

describe("mission store — revocation", () => {
  it("marks a mission revoked immediately, well under 100 ms", () => {
    const store = new MissionStore(statePath(), KEY);
    const { record } = store.create(INPUT, RESOLVED);
    const started = Date.now();
    store.revoke(record.id);
    expect(store.isRevoked(record.jti)).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("revokes by jti as well as by id", () => {
    const store = new MissionStore(statePath(), KEY);
    const { record } = store.create(INPUT, RESOLVED);
    const revoked = store.revoke(record.jti);
    expect(revoked.revokedAt).toBeGreaterThan(0);
    expect(store.isRevoked(record.jti)).toBe(true);
  });

  it("is idempotent: revoking twice keeps the first revocation time", () => {
    const store = new MissionStore(statePath(), KEY);
    const { record } = store.create(INPUT, RESOLVED);
    const first = store.revoke(record.id);
    const second = store.revoke(record.id);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it("throws on an unknown mission id", () => {
    const store = new MissionStore(statePath(), KEY);
    expect(() => store.revoke("msn_nope")).toThrow(/unknown mission/i);
  });

  it("reports false for a jti it has never seen", () => {
    const store = new MissionStore(statePath(), KEY);
    expect(store.isRevoked("11111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("persists revocations to a fresh store instance (new process)", () => {
    const path = statePath();
    const first = new MissionStore(path, KEY);
    const { record } = first.create(INPUT, RESOLVED);
    first.revoke(record.id);

    const second = new MissionStore(path, KEY);
    expect(second.isRevoked(record.jti)).toBe(true);
    expect(second.active()).toHaveLength(0);
  });

  it("keeps unrevoked missions active across instances", () => {
    const path = statePath();
    const first = new MissionStore(path, KEY);
    const { record } = first.create(INPUT, RESOLVED);

    const second = new MissionStore(path, KEY);
    expect(second.active().map((m) => m.id)).toEqual([record.id]);
    expect(second.isRevoked(record.jti)).toBe(false);
  });
});

describe("mission store — active", () => {
  it("excludes expired and revoked missions", () => {
    const store = new MissionStore(statePath(), KEY);
    const live = store.create(INPUT, RESOLVED).record;
    const doomed = store.create({ ...INPUT, ttlSeconds: 60 }, RESOLVED).record;
    const short = store.create({ ...INPUT, ttlSeconds: 30 }, RESOLVED).record;
    store.revoke(doomed.id);

    expect(store.active().map((m) => m.id)).toEqual([live.id, short.id]);
    expect(store.active(short.expiresAt * 1000).map((m) => m.id)).toEqual([
      live.id,
    ]);
  });

  it("carries actor, purpose and scope on the record", () => {
    const store = new MissionStore(statePath(), KEY);
    store.create(INPUT, RESOLVED);
    const [mission] = store.active();
    expect(mission?.actor).toBe("sam@acme.io");
    expect(mission?.purpose).toBe("support case 482");
    expect(mission?.scope.customer).toBe("acme");
  });
});
