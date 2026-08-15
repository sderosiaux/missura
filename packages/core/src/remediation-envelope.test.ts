import { describe, expect, it } from "vitest";
import { buildDenial } from "./remediation";
import { vendorDenialBody } from "./remediation-envelope";
import type { MissuraDenial } from "./remediation-types";
import type { MissionClaims } from "./token";

/**
 * The vendor envelope, tested apart from the wording it carries: these specs
 * are about what an SDK can parse, not about what the agent is told.
 */

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

const DENIAL: MissuraDenial = buildDenial({
  code: "missura_out_of_mission_scope",
  reason: "repo not in mission",
  provider: "github",
  claims: CLAIMS,
  now: NOW,
  scopeSize: 2,
});

describe("vendorDenialBody", () => {
  it("gives Linear a GraphQL envelope with the block under extensions.missura", () => {
    const parsed: unknown = JSON.parse(vendorDenialBody("linear", DENIAL));
    expect(parsed).toEqual({
      errors: [
        {
          message: DENIAL.reason,
          extensions: {
            // The two keys Linear's own errors carry, so `@linear/sdk` builds a
            // typed error rather than an opaque one — and what it surfaces as
            // the message is the remediation, not just the complaint.
            type: "Forbidden",
            userPresentableMessage: `${DENIAL.reason} — ${DENIAL.remediation}`,
            missura: DENIAL,
          },
        },
      ],
    });
  });

  it("maps an identity refusal onto Linear's own authentication error type", () => {
    const denial = buildDenial({
      code: "missura_mission_revoked",
      reason: "revoked",
      provider: "linear",
      claims: CLAIMS,
      now: NOW,
    });
    const parsed = JSON.parse(vendorDenialBody("linear", denial)) as {
      errors: { extensions: { type: string } }[];
    };
    expect(parsed.errors[0]?.extensions.type).toBe("AuthenticationError");
  });

  it("gives GitHub a REST envelope with the block under `missura`", () => {
    const parsed: unknown = JSON.parse(vendorDenialBody("github", DENIAL));
    expect(parsed).toEqual({ message: DENIAL.reason, missura: DENIAL });
  });

  it("keeps a vendor message the caller pins, so a not-found still reads as one", () => {
    const parsed = JSON.parse(
      vendorDenialBody("github", DENIAL, "Not Found"),
    ) as { message: string; missura: MissuraDenial };
    expect(parsed.message).toBe("Not Found");
    expect(parsed.missura.reason).toBe(DENIAL.reason);
  });
});
