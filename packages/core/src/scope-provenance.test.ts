import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openEntityGraph } from "./entity-graph-store";
import { ADEO_JSON, writeGraphFile as write } from "./entity-graph.fixtures";
import {
  resolveScopeFromGraph,
  type ScopeResolution,
} from "./entity-resolve";
import { appendEvent, type DecisionEvent } from "./events";
import { MissionStore } from "./missions";
import { scopeProvenance } from "./scope-provenance";

const ZENDESK_ORG = "360000123456";

function resolution(): ReturnType<typeof resolveScopeFromGraph> {
  return resolveScopeFromGraph(openEntityGraph(write(ADEO_JSON)), {
    kind: "native",
    system: "zendesk",
    id: ZENDESK_ORG,
  });
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "missura-prov-"));
}

const EVENT: DecisionEvent = {
  ts: "2026-08-14T10:00:00.000Z",
  provider: "zendesk",
  operation: "GET /api/v2/tickets/1",
  action: "read",
  decision: "allow",
  reason: "cataloged",
  missionId: "msn_1",
  latencyMs: 42,
};

describe("scope provenance", () => {
  it("names the entity the scope was widened through and the links it used", () => {
    expect(scopeProvenance(resolution())).toEqual({
      via: "entity",
      entityKey: "customer:adeo",
      links: [
        { system: "zendesk", id: ZENDESK_ORG, status: "confirmed" },
        {
          system: "github",
          id: "acme-corp/customer-data:granola-transcripts/adeo",
          status: "confirmed",
        },
      ],
      degraded: [{ system: "linear", reason: "link_proposed", id: "c_18" }],
    });
  });

  it("says a native-only mission used no link at all", () => {
    const out = resolveScopeFromGraph(openEntityGraph(write(ADEO_JSON)), {
      kind: "native",
      system: "zendesk",
      id: "777",
    });
    expect(scopeProvenance(out)).toEqual({
      via: "native",
      links: [],
      degraded: [{ system: "zendesk", reason: "no_entity", id: "777" }],
    });
  });

  it("copies field by field — nothing else on a link rides along", () => {
    const out = resolution();
    const smuggled = {
      ...out,
      used: out.used.map((u) => ({ ...u, evidence: "secret", token: "msr_x" })),
    } as unknown as ScopeResolution;
    const copied = scopeProvenance(smuggled);
    expect(Object.keys(copied.links[0] ?? {})).toEqual([
      "system",
      "id",
      "status",
    ]);
  });
});

describe("decision events carry the provenance", () => {
  it("serializes the whitelisted provenance fields", () => {
    const dir = tmpDir();
    const provenance = scopeProvenance(resolution());
    appendEvent(dir, {
      ...EVENT,
      scopeVia: provenance.via,
      ...(provenance.entityKey === undefined
        ? {}
        : { scopeEntity: provenance.entityKey }),
      scopeLinks: provenance.links,
      scopeDegraded: provenance.degraded,
    });
    const file = readdirSync(dir)[0] ?? "";
    const line: unknown = JSON.parse(
      readFileSync(join(dir, file), "utf8").trimEnd(),
    );
    expect(line).toEqual({
      ...EVENT,
      scopeVia: "entity",
      scopeEntity: "customer:adeo",
      scopeLinks: provenance.links,
      scopeDegraded: provenance.degraded,
    });
  });

  it("drops anything attached to a link or a degradation", () => {
    const dir = tmpDir();
    appendEvent(dir, {
      ...EVENT,
      scopeVia: "entity",
      scopeLinks: [
        {
          system: "zendesk",
          id: ZENDESK_ORG,
          status: "confirmed",
          evidence: "leaked",
        },
      ] as unknown as NonNullable<DecisionEvent["scopeLinks"]>,
      scopeDegraded: [
        {
          system: "linear",
          reason: "link_proposed",
          id: "c_18",
          note: "leaked",
        },
      ] as unknown as NonNullable<DecisionEvent["scopeDegraded"]>,
    });
    const file = readdirSync(dir)[0] ?? "";
    const raw = readFileSync(join(dir, file), "utf8");
    expect(raw).not.toContain("leaked");
  });

  it("leaves an event without provenance untouched", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    const file = readdirSync(dir)[0] ?? "";
    expect(JSON.parse(readFileSync(join(dir, file), "utf8").trimEnd())).toEqual(
      EVENT,
    );
  });
});

describe("a mission records what its scope was built from", () => {
  const key = randomBytes(32);

  function store(): MissionStore {
    return new MissionStore(join(tmpDir(), "missions.json"), key);
  }

  it("keeps the provenance on the record and on disk", () => {
    const path = join(tmpDir(), "missions.json");
    const out = resolution();
    const { record } = new MissionStore(path, key).create(
      {
        purpose: "triage zendesk ticket 1",
        actor: "webhook@missura.dev",
        scope: {},
        ttlSeconds: 600,
      },
      out.scope,
      out,
    );
    expect(record.resolution).toEqual(scopeProvenance(out));
    const reopened = new MissionStore(path, key).active();
    expect(reopened[0]?.resolution?.degraded).toEqual([
      { system: "linear", reason: "link_proposed", id: "c_18" },
    ]);
  });

  it("records no provenance when the mint did not go through the graph", () => {
    const { record } = store().create(
      {
        purpose: "p",
        actor: "a",
        scope: { customer: "acme" },
        ttlSeconds: 600,
      },
      { githubRepos: [] },
    );
    expect(record.resolution).toBeUndefined();
  });

  it("grants the connections the resolved scope proves, zendesk included", () => {
    const out = resolution();
    const { token } = store().create(
      { purpose: "p", actor: "a", scope: {}, ttlSeconds: 600 },
      out.scope,
      out,
    );
    expect(token.startsWith("msr_")).toBe(true);
  });
});
