import { describe, expect, it } from "vitest";
import { connectionsFor } from "./missions";
import { openEntityGraph } from "./entity-graph-store";
import {
  ADEO_JSON,
  oneLink,
  writeGraphFile as write,
} from "./entity-graph.fixtures";
import { resolveScopeFromGraph } from "./entity-resolve";
import type { LinkStatus } from "./entity-graph";

const adeo = (): ReturnType<typeof openEntityGraph> =>
  openEntityGraph(write(ADEO_JSON));

const ZENDESK_ORG = "360000123456";
const GITHUB_LINK = "acme-corp/customer-data:granola-transcripts/adeo";

describe("forward resolution — entity key to its confirmed links", () => {
  it("resolves only what is confirmed", () => {
    const out = resolveScopeFromGraph(adeo(), {
      kind: "entity",
      key: "customer:adeo",
    });
    expect(out.scope).toEqual({
      githubRepos: [
        {
          repo: "acme-corp/customer-data",
          pathPrefix: "granola-transcripts/adeo",
        },
      ],
      zendeskOrganizationIds: [ZENDESK_ORG],
    });
    expect(out.via).toBe("entity");
    expect(out.systems).toEqual(["github", "zendesk"]);
  });

  it("reports the proposed link it did NOT use, rather than omitting it", () => {
    const out = resolveScopeFromGraph(adeo(), {
      kind: "entity",
      key: "customer:adeo",
    });
    expect(out.degraded).toEqual([
      { system: "linear", reason: "link_proposed", id: "c_18" },
    ]);
  });

  it("carries the links the scope was built from, with their status", () => {
    const out = resolveScopeFromGraph(adeo(), {
      kind: "entity",
      key: "customer:adeo",
    });
    expect(out.used).toEqual([
      { system: "zendesk", id: ZENDESK_ORG, status: "confirmed" },
      { system: "github", id: GITHUB_LINK, status: "confirmed" },
    ]);
  });

  it("throws on an unknown entity — a vanished entity must not mint", () => {
    expect(() =>
      resolveScopeFromGraph(adeo(), { kind: "entity", key: "customer:nope" }),
    ).toThrow("unknown entity: customer:nope");
  });
});

describe("only a confirmed link widens a mission", () => {
  const inert: readonly LinkStatus[] = ["proposed", "rejected", "broken"];

  it.each(inert)("a %s zendesk link never reaches a ResolvedScope", (status) => {
    const store = openEntityGraph(
      write(oneLink({ system: "zendesk", id: "999", status })),
    );
    const forward = resolveScopeFromGraph(store, {
      kind: "entity",
      key: "customer:adeo",
    });
    expect(forward.scope.zendeskOrganizationIds ?? []).toEqual([]);
    expect(connectionsFor(forward.scope)).toEqual([]);
  });

  it.each(inert)("a %s github link never reaches a ResolvedScope", (status) => {
    const store = openEntityGraph(
      write(oneLink({ system: "github", id: "octo/cat", status })),
    );
    expect(
      resolveScopeFromGraph(store, { kind: "entity", key: "customer:adeo" })
        .scope.githubRepos,
    ).toEqual([]);
  });

  it.each(inert)("a %s linear link never reaches a ResolvedScope", (status) => {
    const store = openEntityGraph(
      write(oneLink({ system: "linear", id: "c_1", status })),
    );
    expect(
      resolveScopeFromGraph(store, { kind: "entity", key: "customer:adeo" })
        .scope.linearCustomerId,
    ).toBeUndefined();
  });

  it("stays inert even when the method is deterministic and obvious", () => {
    const store = openEntityGraph(
      write(
        oneLink({
          system: "zendesk",
          id: "999",
          status: "proposed",
          method: "deterministic",
        }),
      ),
    );
    const out = resolveScopeFromGraph(store, {
      kind: "entity",
      key: "customer:adeo",
    });
    expect(out.scope.zendeskOrganizationIds ?? []).toEqual([]);
    expect(out.degraded).toEqual([
      { system: "zendesk", reason: "link_proposed", id: "999" },
    ]);
  });

  it("names the reason per status", () => {
    const reasons = inert.map((status) => {
      const store = openEntityGraph(
        write(oneLink({ system: "linear", id: "c_1", status })),
      );
      return resolveScopeFromGraph(store, {
        kind: "entity",
        key: "customer:adeo",
      }).degraded[0]?.reason;
    });
    expect(reasons).toEqual(["link_proposed", "link_rejected", "link_broken"]);
  });

  it("still degrades a system that already has one confirmed link", () => {
    const store = openEntityGraph(
      write(
        JSON.stringify({
          version: 1,
          entities: {
            "customer:adeo": {
              displayName: "ADEO",
              domains: ["adeo.com"],
              links: [
                { system: "zendesk", id: "1", evidence: "e", method: "manual", status: "confirmed", confirmedBy: "ops" },
                { system: "zendesk", id: "2", evidence: "e", method: "inferred", status: "proposed" },
              ],
            },
          },
        }),
      ),
    );
    const out = resolveScopeFromGraph(store, {
      kind: "entity",
      key: "customer:adeo",
    });
    expect(out.scope.zendeskOrganizationIds).toEqual(["1"]);
    expect(out.degraded).toEqual([
      { system: "zendesk", reason: "link_proposed", id: "2" },
    ]);
  });
});

describe("reverse resolution — a native id is all a webhook has", () => {
  it("finds the entity through a confirmed link and adds its other systems", () => {
    const out = resolveScopeFromGraph(adeo(), {
      kind: "native",
      system: "zendesk",
      id: ZENDESK_ORG,
    });
    expect(out.via).toBe("entity");
    expect(out.scope.zendeskOrganizationIds).toEqual([ZENDESK_ORG]);
    expect(out.scope.githubRepos).toHaveLength(1);
    expect(out.used.map((u) => u.system)).toEqual(["zendesk", "github"]);
  });

  it("returns immediately, degraded, when the other link is only proposed", () => {
    const out = resolveScopeFromGraph(adeo(), {
      kind: "native",
      system: "zendesk",
      id: ZENDESK_ORG,
    });
    expect(out.scope.linearCustomerId).toBeUndefined();
    expect(out.degraded).toEqual([
      { system: "linear", reason: "link_proposed", id: "c_18" },
    ]);
  });

  it("yields the native-only scope for an unknown id, never an empty one", () => {
    const out = resolveScopeFromGraph(adeo(), {
      kind: "native",
      system: "zendesk",
      id: "777",
    });
    expect(out.via).toBe("native");
    expect(out.scope).toEqual({ githubRepos: [], zendeskOrganizationIds: ["777"] });
    expect(out.systems).toEqual(["zendesk"]);
    expect(out.used).toEqual([]);
    expect(out.degraded).toEqual([
      { system: "zendesk", reason: "no_entity", id: "777" },
    ]);
    expect(connectionsFor(out.scope)).toEqual(["zendesk"]);
  });

  it("works with no graph at all — the graph only ever ADDS systems", () => {
    const empty = openEntityGraph(write(JSON.stringify({ version: 1, entities: {} })));
    const out = resolveScopeFromGraph(empty, {
      kind: "native",
      system: "github",
      id: "octo/cat:t/adeo",
    });
    expect(out.scope.githubRepos).toEqual([
      { repo: "octo/cat", pathPrefix: "t/adeo" },
    ]);
    expect(out.systems).toEqual(["github"]);
  });

  it("carries a native linear id as the single system it is", () => {
    const out = resolveScopeFromGraph(adeo(), {
      kind: "native",
      system: "linear",
      id: "c_99",
    });
    expect(out.scope.linearCustomerId).toBe("c_99");
    expect(out.scope.githubRepos).toEqual([]);
    expect(connectionsFor(out.scope)).toEqual(["linear"]);
  });

  it("refuses a native id that is not readable in its own system", () => {
    expect(() =>
      resolveScopeFromGraph(adeo(), {
        kind: "native",
        system: "github",
        id: "product",
      }),
    ).toThrow(/invalid repo.*product/i);
  });
});

describe("reverse resolution fails closed", () => {
  const twoEntities = JSON.stringify({
    version: 1,
    entities: {
      "customer:adeo": {
        displayName: "ADEO",
        domains: ["adeo.com"],
        links: [
          { system: "zendesk", id: "1", evidence: "e", method: "manual", status: "confirmed", confirmedBy: "ops" },
          { system: "github", id: "octo/adeo", evidence: "e", method: "manual", status: "confirmed", confirmedBy: "ops" },
        ],
      },
      "customer:leroy": {
        displayName: "Leroy",
        domains: ["leroymerlin.es"],
        links: [
          { system: "zendesk", id: "1", evidence: "e", method: "inferred", status: "confirmed", confirmedBy: "ops" },
          { system: "linear", id: "c_77", evidence: "e", method: "manual", status: "confirmed", confirmedBy: "ops" },
        ],
      },
    },
  });

  it("never picks one of two entities holding the same confirmed id", () => {
    const out = resolveScopeFromGraph(openEntityGraph(write(twoEntities)), {
      kind: "native",
      system: "zendesk",
      id: "1",
    });
    expect(out.via).toBe("native");
    expect(out.scope).toEqual({ githubRepos: [], zendeskOrganizationIds: ["1"] });
    expect(out.degraded).toEqual([
      { system: "zendesk", reason: "ambiguous_entity", id: "1" },
    ]);
  });

  it("treats a rejected link as absent and says so", () => {
    const store = openEntityGraph(
      write(oneLink({ system: "zendesk", id: "5", status: "rejected" })),
    );
    const out = resolveScopeFromGraph(store, {
      kind: "native",
      system: "zendesk",
      id: "5",
    });
    expect(out.via).toBe("native");
    expect(out.scope.zendeskOrganizationIds).toEqual(["5"]);
    expect(out.degraded).toEqual([
      { system: "zendesk", reason: "link_rejected", id: "5" },
    ]);
  });

  it("treats a broken link as absent — a stale mapping stops granting", () => {
    const store = openEntityGraph(
      write(oneLink({ system: "zendesk", id: "5", status: "broken" })),
    );
    const out = resolveScopeFromGraph(store, {
      kind: "native",
      system: "zendesk",
      id: "5",
    });
    expect(out.via).toBe("native");
    expect(out.degraded).toEqual([
      { system: "zendesk", reason: "link_broken", id: "5" },
    ]);
  });

  it("does not reach an entity through a proposed link", () => {
    const store = openEntityGraph(
      write(oneLink({ system: "zendesk", id: "5", status: "proposed" })),
    );
    const out = resolveScopeFromGraph(store, {
      kind: "native",
      system: "zendesk",
      id: "5",
    });
    expect(out.via).toBe("native");
    expect(out.degraded).toEqual([
      { system: "zendesk", reason: "link_proposed", id: "5" },
    ]);
  });
});
