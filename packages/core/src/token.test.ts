import { describe, expect, it } from "vitest";
import { signMissionToken, verifyMissionToken } from "./token";

const KEY = Buffer.from("k".repeat(32));
const MISSION = {
  id: "msn_482",
  purpose: "support case 482",
  scope: { customer: "acme", repos: ["acme-corp/product"] },
  connections: ["linear", "github"],
  allow: ["search", "read"] as const,
};

describe("mission token", () => {
  it("round-trips claims through sign/verify", () => {
    const token = signMissionToken(MISSION, { key: KEY, ttlSeconds: 1800 });
    const claims = verifyMissionToken(token, { key: KEY });
    expect(claims.id).toBe("msn_482");
    expect(claims.purpose).toBe("support case 482");
    expect(claims.scope.customer).toBe("acme");
    expect(claims.allow).toEqual(["search", "read"]);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("prefixes tokens with msr_", () => {
    const token = signMissionToken(MISSION, { key: KEY, ttlSeconds: 60 });
    expect(token.startsWith("msr_")).toBe(true);
  });

  it("rejects a tampered token", () => {
    const token = signMissionToken(MISSION, { key: KEY, ttlSeconds: 60 });
    const bad = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(() => verifyMissionToken(bad, { key: KEY })).toThrow(/signature/i);
  });

  it("rejects a token signed with another key", () => {
    const token = signMissionToken(MISSION, { key: KEY, ttlSeconds: 60 });
    expect(() =>
      verifyMissionToken(token, { key: Buffer.from("x".repeat(32)) }),
    ).toThrow(/signature/i);
  });

  it("rejects an expired token", () => {
    const token = signMissionToken(MISSION, {
      key: KEY,
      ttlSeconds: -10, // already expired
    });
    expect(() => verifyMissionToken(token, { key: KEY })).toThrow(/expired/i);
  });
});
