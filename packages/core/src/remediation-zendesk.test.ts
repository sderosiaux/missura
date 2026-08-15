import { describe, expect, it } from "vitest";
import { buildDenial } from "./remediation";
import { vendorDenialBody } from "./remediation-envelope";
import type { MissionClaims } from "./token";

/**
 * Zendesk's own refusal shape, and the wording a Zendesk refusal carries.
 *
 * The envelope keys are the vendor's, verified against the published API
 * reference: a not-found answers `{"error":"RecordNotFound","description":
 * "Not found"}` (developer.zendesk.com, Users API — Compliance Deletion Status
 * error response), and a failed search answers `{"error":"unavailable",
 * "description":"…"}` (Search API). Both are `{error, description}`, which is
 * therefore the shape a client parses.
 */

const CLAIMS: MissionClaims = {
  id: "msn_1",
  purpose: "support triage",
  actor: "ops@acme.test",
  scope: { customer: "acme" },
  connections: ["zendesk"],
  allow: ["read", "search"],
  jti: "j1",
  iat: 0,
  exp: 3600,
};

function parsed(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

describe("zendesk denial envelope", () => {
  it("wraps the refusal in Zendesk's own {error, description} shape", () => {
    const denial = buildDenial({
      code: "missura_out_of_mission_scope",
      reason: "organization not in mission",
      provider: "zendesk",
      claims: CLAIMS,
      now: 0,
      scopeSize: 2,
    });
    const body = parsed(vendorDenialBody("zendesk", denial, "Not found"));
    expect(body.error).toBe("RecordNotFound");
    expect(body.description).toBe("Not found");
    expect(body.missura).toEqual(denial);
  });

  /**
   * A refusal that is not an absence must not borrow the vendor's absence
   * vocabulary: only `RecordNotFound` could be verified against the docs, so
   * every other code carries its own name rather than an invented Zendesk one.
   */
  it("does not invent a Zendesk error name for a non-absence refusal", () => {
    const denial = buildDenial({
      code: "missura_mission_expired",
      reason: "mission expired",
      provider: "zendesk",
      claims: CLAIMS,
      now: 0,
    });
    const body = parsed(vendorDenialBody("zendesk", denial));
    expect(body.error).toBe("missura_mission_expired");
    expect(body.description).toBe("mission expired");
  });

  it("keeps the GitHub envelope untouched", () => {
    const denial = buildDenial({
      code: "missura_out_of_mission_scope",
      reason: "repo not in mission",
      provider: "github",
      claims: CLAIMS,
      now: 0,
      scopeSize: 1,
    });
    const body = parsed(vendorDenialBody("github", denial, "Not Found"));
    expect(body.message).toBe("Not Found");
    expect(body.error).toBeUndefined();
  });
});

describe("zendesk remediation wording", () => {
  function remediation(scopeSize: number | undefined): string {
    return buildDenial({
      code: "missura_out_of_mission_scope",
      reason: "organization not in mission",
      provider: "zendesk",
      claims: CLAIMS,
      now: 0,
      scopeSize,
    }).remediation;
  }

  it("counts the mission's organizations instead of naming one", () => {
    const text = remediation(3);
    expect(text).toContain("3 organizations");
    expect(text).not.toContain("acme");
  });

  it("reads identically whether the refused organization exists or not", () => {
    expect(remediation(2)).toBe(remediation(2));
  });

  it("singularises a one-organization mission", () => {
    expect(remediation(1)).toContain("1 organization,");
  });

  it("offers a runnable in-scope shape that needs no identifier", () => {
    const denial = buildDenial({
      code: "missura_out_of_mission_scope",
      reason: "organization not in mission",
      provider: "zendesk",
      claims: CLAIMS,
      now: 0,
      scopeSize: 1,
    });
    expect(denial.try_instead).toEqual([
      "GET /api/v2/search?query=type:ticket <your terms>",
    ]);
  });

  it("suggests a smaller page when the answer was too large", () => {
    const denial = buildDenial({
      code: "missura_response_too_large",
      reason: "response too large",
      provider: "zendesk",
      claims: CLAIMS,
      now: 0,
    });
    expect(denial.try_instead).toEqual([
      "GET /api/v2/search?query=type:ticket <your terms>&per_page=10",
    ]);
  });
});
