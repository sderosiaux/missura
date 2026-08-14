import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signMissionToken, verifyMissionToken } from "./token";

const KEY = Buffer.from("k".repeat(32));

/** Mints a token from an arbitrary payload using the same HMAC scheme. */
function forge(claims: unknown, key: Buffer = KEY): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `msr_${payload}.${sig}`;
}

function decodePayload(token: string): Record<string, unknown> {
  const body = token.slice("msr_".length);
  const payload = body.slice(0, body.lastIndexOf("."));
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

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

  it("rejects a validly signed token whose payload has no exp", () => {
    const token = forge({
      ...MISSION,
      jti: "11111111-1111-4111-8111-111111111111",
      iat: Math.floor(Date.now() / 1000),
    });
    expect(() => verifyMissionToken(token, { key: KEY })).toThrow(
      /invalid claims/i,
    );
  });

  it("rejects a validly signed token whose exp is a string", () => {
    const token = forge({
      ...MISSION,
      jti: "11111111-1111-4111-8111-111111111111",
      iat: Math.floor(Date.now() / 1000),
      exp: String(Math.floor(Date.now() / 1000) + 600),
    });
    expect(() => verifyMissionToken(token, { key: KEY })).toThrow(
      /invalid claims/i,
    );
  });

  it("rejects claims widened without re-signing", () => {
    const token = signMissionToken(MISSION, { key: KEY, ttlSeconds: 600 });
    const claims = decodePayload(token);
    claims.allow = ["read", "write", "admin"];
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
      "base64url",
    );
    expect(() =>
      verifyMissionToken(`msr_${payload}.${sig}`, { key: KEY }),
    ).toThrow(/signature/i);
  });

  it("refuses keys shorter than 32 bytes", () => {
    const weak = Buffer.from("k".repeat(31));
    expect(() =>
      signMissionToken(MISSION, { key: weak, ttlSeconds: 60 }),
    ).toThrow(/key/i);
    const token = signMissionToken(MISSION, { key: KEY, ttlSeconds: 60 });
    expect(() => verifyMissionToken(token, { key: weak })).toThrow(/key/i);
  });

  it("treats exp as exclusive at the ttl boundary", () => {
    const iat = 1_800_000_000;
    const token = signMissionToken(MISSION, {
      key: KEY,
      ttlSeconds: 60,
      now: iat * 1000,
    });
    expect(
      verifyMissionToken(token, { key: KEY, now: (iat + 59) * 1000 }).exp,
    ).toBe(iat + 60);
    expect(() =>
      verifyMissionToken(token, { key: KEY, now: (iat + 60) * 1000 }),
    ).toThrow(/expired/i);
  });
});
