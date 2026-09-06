import { describe, expect, it } from "vitest";
import { missionIntrospection } from "./introspection";
import type { MissionClaims } from "./token";

const NOW = 1_700_000_000_000;

const CLAIMS: MissionClaims = {
  id: "msn_1",
  purpose: "support case 482",
  actor: "sam@acme.io",
  scope: { entity: "customer:zoetis" },
  connections: ["github", "zendesk"],
  allow: ["read", "search"],
  degraded: [{ system: "linear", reason: "link_proposed" }],
  jti: "jti-1",
  iat: Math.floor(NOW / 1000) - 60,
  exp: Math.floor(NOW / 1000) + 540,
};

describe("mission introspection — what the agent may be told it is", () => {
  it("describes the mission from its own claims and nothing else", () => {
    expect(missionIntrospection(CLAIMS, NOW)).toEqual({
      entity: "customer:zoetis",
      purpose: "support case 482",
      actor: "sam@acme.io",
      expires_in: 540,
      allow: ["read", "search"],
      systems: ["github", "zendesk"],
      degraded: [{ system: "linear", reason: "link_proposed" }],
    });
  });

  it("floors a spent lifetime at zero", () => {
    expect(
      missionIntrospection(CLAIMS, NOW + 3_600_000).expires_in,
    ).toBe(0);
  });

  it("names no entity when the scope has none", () => {
    const out = missionIntrospection(
      { ...CLAIMS, scope: { repos: ["acme-corp/product"] } },
      NOW,
    );
    expect("entity" in out).toBe(false);
  });

  /**
   * The projection is field by field, like the provenance record: a claims
   * object reaches this from a token, and whatever else rides on a degradation
   * there — an id, most of all — must not ride out.
   */
  it("copies a degradation by system and reason only", () => {
    const smuggled = {
      ...CLAIMS,
      degraded: [
        { system: "linear", reason: "link_proposed", id: "c_77", note: "x" },
      ],
    } as unknown as MissionClaims;
    const out = missionIntrospection(smuggled, NOW);
    expect(out.degraded).toEqual([{ system: "linear", reason: "link_proposed" }]);
    expect(JSON.stringify(out)).not.toContain("c_77");
  });
});
