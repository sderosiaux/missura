import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openEntityGraph } from "./entity-graph-store";
import { ADEO_JSON, writeGraphFile as write } from "./entity-graph.fixtures";
import { resolveScopeFromGraph, scopeRequestFor } from "./entity-resolve";
import { signMissionToken, verifyMissionToken } from "./token";

describe("what a mission scope asks the graph", () => {
  it("reads a native scope as the single system it is", () => {
    expect(scopeRequestFor({ native: { system: "zendesk", id: "360000123456" } })).toEqual({
      kind: "native",
      system: "zendesk",
      id: "360000123456",
    });
  });

  it("reads an entity scope as the key it already holds — no prefixing", () => {
    expect(scopeRequestFor({ entity: "customer:adeo" })).toEqual({
      kind: "entity",
      key: "customer:adeo",
    });
  });

  it("carries any entity type, because an entity is not always a customer", () => {
    expect(scopeRequestFor({ entity: "employee:stephane" })).toEqual({
      kind: "entity",
      key: "employee:stephane",
    });
  });

  it("refuses a bare name — the scope holds a key, never a name", () => {
    expect(() => scopeRequestFor({ entity: "adeo" })).toThrow(/type:name/);
  });

  it("asks the graph nothing for a scope that names no entity", () => {
    expect(scopeRequestFor({})).toBeUndefined();
    expect(scopeRequestFor({ repos: ["octo/cat"] })).toBeUndefined();
  });

  it("refuses a scope that is both — one scope, one meaning", () => {
    expect(() =>
      scopeRequestFor({
        entity: "customer:adeo",
        native: { system: "zendesk", id: "1" },
      }),
    ).toThrow(/both/i);
  });

  it("survives a token round trip, so the proxy re-resolves what was minted", () => {
    const key = randomBytes(32);
    const token = signMissionToken(
      {
        id: "msn_1",
        purpose: "triage",
        actor: "webhook@missura.dev",
        scope: { native: { system: "zendesk", id: "360000123456" } },
        connections: ["zendesk"],
        allow: ["read"],
      },
      { key, ttlSeconds: 600 },
    );
    const claims = verifyMissionToken(token, { key });
    const request = scopeRequestFor(claims.scope);
    expect(request).toEqual({
      kind: "native",
      system: "zendesk",
      id: "360000123456",
    });
    const out = resolveScopeFromGraph(
      openEntityGraph(write(ADEO_JSON)),
      request ?? { kind: "entity", key: "unused" },
    );
    expect(out.via).toBe("entity");
    expect(out.scope.githubRepos).toHaveLength(1);
  });
});
