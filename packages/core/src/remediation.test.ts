import { describe, expect, it } from "vitest";
import { buildDenial, missionSummary } from "./remediation";
import type { MissionClaims } from "./token";

const CLAIMS: MissionClaims = {
  id: "msn_1",
  purpose: "support investigation",
  actor: "sam@acme",
  scope: { customer: "acme" },
  connections: ["linear"],
  allow: ["read", "search"],
  jti: "jti-1",
  iat: 1_000,
  exp: 2_000,
};

const NOW = 1_000_000; // ms ⇒ epoch second 1_000

describe("missionSummary", () => {
  it("renders the mission the agent already holds — scope, actions, remaining life", () => {
    expect(missionSummary(CLAIMS, NOW)).toEqual({
      scope: "customer:acme",
      allowed_actions: ["read", "search"],
      expires_in: 1_000,
    });
  });

  it("never reports a negative lifetime for a mission already past its exp", () => {
    expect(missionSummary(CLAIMS, 9_000_000).expires_in).toBe(0);
  });

  it("counts the mission's repos instead of naming them", () => {
    const claims: MissionClaims = {
      ...CLAIMS,
      scope: { repos: ["acme/product", "acme/infra"] },
    };
    expect(missionSummary(claims, NOW).scope).toBe("repos:2");
  });

  it("says so out loud when a mission carries no business scope at all", () => {
    expect(missionSummary({ ...CLAIMS, scope: {} }, NOW).scope).toBe(
      "unscoped",
    );
  });
});

describe("buildDenial", () => {
  it("carries the whole §4.8bis contract on every code", () => {
    const codes = [
      "missura_unauthenticated",
      "missura_mission_expired",
      "missura_mission_revoked",
      "missura_connection_not_in_mission",
      "missura_action_not_allowed",
      "missura_operation_not_in_catalog",
      "missura_out_of_mission_scope",
      "missura_invalid_target",
      "missura_response_too_large",
      "missura_upstream_error",
      "missura_internal",
    ] as const;
    for (const code of codes) {
      const denial = buildDenial({
        code,
        reason: "some reason",
        provider: "linear",
        claims: CLAIMS,
        now: NOW,
      });
      expect(denial.code, code).toBe(code);
      expect(denial.reason, code).toBe("some reason");
      expect(denial.mission, code).toEqual(missionSummary(CLAIMS, NOW));
      expect(denial.remediation.length, code).toBeGreaterThan(20);
      expect(Array.isArray(denial.try_instead), code).toBe(true);
      expect(denial.introspect.length, code).toBeGreaterThan(0);
    }
  });

  it("omits the mission block when no verified mission exists", () => {
    const denial = buildDenial({
      code: "missura_unauthenticated",
      reason: "authn: missing or invalid mission token",
      provider: "github",
    });
    expect(denial.mission).toBeUndefined();
    expect(denial.remediation).toContain("Authorization");
  });

  it("points an expired mission at the operator, not at the request", () => {
    const denial = buildDenial({
      code: "missura_mission_expired",
      reason: "expired",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
    });
    expect(denial.remediation).toContain("expired");
    expect(denial.remediation).toContain("operator");
    // Nothing about the request can fix it, so nothing is suggested.
    expect(denial.try_instead).toEqual([]);
  });

  it("points a revoked mission at the operator too", () => {
    const denial = buildDenial({
      code: "missura_mission_revoked",
      reason: "revoked",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
    });
    expect(denial.remediation).toContain("revoked");
    expect(denial.remediation).toContain("operator");
    expect(denial.try_instead).toEqual([]);
  });

  it("names the connections the mission does cover", () => {
    const denial = buildDenial({
      code: "missura_connection_not_in_mission",
      reason: "connection not in mission",
      provider: "github",
      claims: CLAIMS,
      now: NOW,
    });
    expect(denial.remediation).toContain("linear");
  });

  it("names the actions the mission allows and the one this call needed", () => {
    const denial = buildDenial({
      code: "missura_action_not_allowed",
      reason: "action not allowed by mission",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
      requiredAction: "write",
    });
    expect(denial.remediation).toContain("read, search");
    expect(denial.remediation).toContain("write");
  });

  it("names the denied field the agent wrote and the alternative in scope", () => {
    const denial = buildDenial({
      code: "missura_out_of_mission_scope",
      reason: "root field `projects` is not narrowable under a mission scope",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
    });
    expect(denial.remediation).toContain("`projects`");
    expect(denial.remediation).toContain("customer:acme");
    expect(denial.try_instead.join(" ")).toContain("issues");
  });

  it("names a field the walk refused deeper in the selection", () => {
    const denial = buildDenial({
      code: "missura_out_of_mission_scope",
      reason:
        "field `team` (`issues > nodes > team`) is outside the mission traversal allowlist",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
    });
    expect(denial.remediation).toContain("drop `team`");
  });

  /**
   * "Drop it" is only advice when what was refused IS a field. A refusal about
   * the SHAPE of the request — a fragment that could not be inlined, an
   * unparseable filter — quotes something the agent cannot simply remove, so
   * the remediation must not tell it to.
   */
  it("does not tell the agent to drop something that is not a field", () => {
    const denial = buildDenial({
      code: "missura_out_of_mission_scope",
      reason:
        "fragment inside the `issue` selection — ownership cannot be proven",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
    });
    expect(denial.remediation).not.toContain("drop `issue`");
    expect(denial.remediation).toContain("`reason`");
    expect(denial.remediation).toContain("customer:acme");
  });

  it("counts the mission's repos without naming a single one", () => {
    const denial = buildDenial({
      code: "missura_out_of_mission_scope",
      reason: "repo not in mission",
      provider: "github",
      claims: { ...CLAIMS, connections: ["github"] },
      now: NOW,
      scopeSize: 3,
    });
    expect(denial.remediation).toContain("3");
    // A runnable alternative that needs no repo name: search is forced onto
    // the mission's repos by the connector.
    expect(denial.try_instead.join(" ")).toContain("/search/issues");
  });

  /**
   * A path-scoped mission cannot search: no `/search/issues` result names the
   * path it lives at, so the connector refuses the route outright. Sending the
   * agent at it would be the hallucinated-workaround failure §4.8bis exists to
   * prevent — the remediation must offer the one route that CAN work.
   */
  it("never points a path-scoped refusal at the search route it also refuses", () => {
    const denial = buildDenial({
      code: "missura_out_of_path_scope",
      reason: "path outside the mission's path prefix",
      provider: "github",
      claims: { ...CLAIMS, connections: ["github"] },
      now: NOW,
      scopeSize: 1,
    });
    expect(denial.try_instead.join(" ")).not.toContain("/search/issues");
    expect(denial.try_instead.join(" ")).toContain("contents");
    expect(denial.remediation).toContain("1");
    expect(denial.remediation).toContain("contents");
    // Counted, never named: the wording must not describe the denied target.
    expect(denial.remediation).not.toContain("granola");
  });

  it("suggests a smaller page when the vendor's answer was too large", () => {
    const linear = buildDenial({
      code: "missura_response_too_large",
      reason: "response too large (after upstream call)",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
    });
    expect(linear.try_instead.join(" ")).toContain("first:");
    const github = buildDenial({
      code: "missura_response_too_large",
      reason: "response too large (after upstream call)",
      provider: "github",
      claims: CLAIMS,
      now: NOW,
    });
    expect(github.try_instead.join(" ")).toContain("per_page");
  });

  it("does not promise an introspection surface that does not exist yet", () => {
    const denial = buildDenial({
      code: "missura_internal",
      reason: "internal",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
    });
    expect(denial.introspect.toLowerCase()).toContain("not available");
  });
});
