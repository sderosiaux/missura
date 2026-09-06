import { describe, expect, it } from "vitest";
import { entityGraphReader, openEntityGraph } from "./entity-graph-store";
import {
  ADEO_JSON,
  oneLink,
  writeGraphFile as write,
} from "./entity-graph.fixtures";
import { connectionsFor } from "./mission-record";
import { resolveMissionScope } from "./scope-resolve";

const GITHUB_LINK = {
  repo: "acme-corp/customer-data",
  pathPrefix: "granola-transcripts/adeo",
};

const adeo = (): ReturnType<typeof openEntityGraph> =>
  openEntityGraph(write(ADEO_JSON));

const empty = (): ReturnType<typeof entityGraphReader> =>
  entityGraphReader({ version: 1, entities: [] });

describe("a mission scope, resolved through the graph", () => {
  it("covers every CONFIRMED system of the entity it names", () => {
    const out = resolveMissionScope(adeo(), { entity: "customer:adeo" });
    expect(out.scope.githubRepos).toEqual([GITHUB_LINK]);
    expect(out.scope.zendeskOrganizationIds).toEqual(["360000123456"]);
    expect(connectionsFor(out.scope)).toEqual(["github", "zendesk"]);
  });

  it("carries the degradation onto the mission rather than dropping it", () => {
    const out = resolveMissionScope(adeo(), { entity: "customer:adeo" });
    expect(out.resolution?.degraded).toEqual([
      { system: "linear", reason: "link_proposed", id: "c_18" },
    ]);
    expect(out.scope.linearCustomerId).toBeUndefined();
  });

  it("throws on an unknown entity — a vanished entity must not mint", () => {
    expect(() =>
      resolveMissionScope(adeo(), { entity: "customer:nope" }),
    ).toThrow("unknown entity: customer:nope");
  });

  it("unions explicit repos with the entity's confirmed ones", () => {
    const out = resolveMissionScope(adeo(), {
      entity: "customer:adeo",
      repos: ["octo/cat"],
    });
    expect(out.scope.githubRepos).toEqual([GITHUB_LINK, { repo: "octo/cat" }]);
  });

  it("dedupes an explicit repo the entity already carries", () => {
    const out = resolveMissionScope(adeo(), {
      entity: "customer:adeo",
      repos: ["ACME-Corp/Customer-Data:granola-transcripts/adeo"],
    });
    expect(out.scope.githubRepos).toEqual([GITHUB_LINK]);
  });

  /**
   * The graph only ever ADDS. A scope naming only repositories is enforced with
   * no graph in the picture, so a deployment with no graph at all still works.
   */
  it("resolves a repos-only scope without asking the graph anything", () => {
    const out = resolveMissionScope(empty(), { repos: ["octo/cat:t/adeo"] });
    expect(out.scope.githubRepos).toEqual([
      { repo: "octo/cat", pathPrefix: "t/adeo" },
    ]);
    expect(out.resolution).toBeUndefined();
  });

  it("refuses an explicit repo that is not owner/name, before minting", () => {
    expect(() => resolveMissionScope(empty(), { repos: ["product"] })).toThrow(
      /invalid repo.*product/i,
    );
  });

  it("resolves an empty scope to nothing at all, and asks nothing", () => {
    const out = resolveMissionScope(empty(), {});
    expect(out.scope).toEqual({ githubRepos: [], zendeskOrganizationIds: [] });
    expect(out.resolution).toBeUndefined();
  });
});

describe("a native scope reaches the entity, or degrades to the id itself", () => {
  it("widens a confirmed native id to the entity's other systems", () => {
    const out = resolveMissionScope(adeo(), {
      native: { system: "zendesk", id: "360000123456" },
    });
    expect(out.resolution?.via).toBe("entity");
    expect(out.scope.githubRepos).toEqual([GITHUB_LINK]);
  });

  /** An unknown entity KEY fails the mint; an unknown native id does not. */
  it("keeps an unknown native id as a native-only scope, and names why", () => {
    const out = resolveMissionScope(adeo(), {
      native: { system: "zendesk", id: "777" },
    });
    expect(out.resolution?.via).toBe("native");
    expect(out.scope.zendeskOrganizationIds).toEqual(["777"]);
    expect(out.resolution?.degraded).toEqual([
      { system: "zendesk", reason: "no_entity", id: "777" },
    ]);
    expect(connectionsFor(out.scope)).toEqual(["zendesk"]);
  });

  it("does not reach an entity through a link only proposed", () => {
    const reader = openEntityGraph(
      write(oneLink({ system: "zendesk", id: "5", status: "proposed" })),
    );
    const out = resolveMissionScope(reader, {
      native: { system: "zendesk", id: "5" },
    });
    expect(out.resolution?.via).toBe("native");
    expect(out.resolution?.degraded).toEqual([
      { system: "zendesk", reason: "link_proposed", id: "5" },
    ]);
  });
});
