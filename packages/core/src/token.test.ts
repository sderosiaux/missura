import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_TTL_SECONDS,
  signDevToken,
  signMissionToken,
  verifyMissionToken,
} from "./token";

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
  actor: "sam@acme.io",
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
    expect(claims.actor).toBe("sam@acme.io");
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
      ttlSeconds: 60,
      now: Date.now() - 3_600_000, // minted an hour ago: already expired
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

  it("rejects a validly signed token with no actor claim", () => {
    const noActor: Record<string, unknown> = { ...MISSION };
    delete noActor.actor;
    const token = forge({
      ...noActor,
      jti: "11111111-1111-4111-8111-111111111111",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect(() => verifyMissionToken(token, { key: KEY })).toThrow(
      /invalid claims: actor/i,
    );
  });

  it("rejects non-string elements in connections", () => {
    const token = forge({
      ...MISSION,
      connections: ["linear", 42],
      jti: "11111111-1111-4111-8111-111111111111",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect(() => verifyMissionToken(token, { key: KEY })).toThrow(
      /invalid claims: connections/i,
    );
  });

  it("rejects non-string elements in allow", () => {
    const token = forge({
      ...MISSION,
      allow: ["read", { admin: true }],
      jti: "11111111-1111-4111-8111-111111111111",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect(() => verifyMissionToken(token, { key: KEY })).toThrow(
      /invalid claims: allow/i,
    );
  });

  it("rejects nested arrays smuggled into allow", () => {
    const token = forge({
      ...MISSION,
      allow: [["read"]],
      jti: "11111111-1111-4111-8111-111111111111",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect(() => verifyMissionToken(token, { key: KEY })).toThrow(
      /invalid claims: allow/i,
    );
  });
});

describe("dev token", () => {
  it("verifies with the same key and carries the dev mission id", () => {
    const claims = verifyMissionToken(
      signDevToken({ key: KEY, ttlSeconds: 3600 }),
      { key: KEY },
    );
    expect(claims.id).toBe("msn_dev");
    expect(claims.purpose).toBe("m1 dev token — scope all");
    expect(claims.actor).toBe("dev@local");
  });

  it("scopes all: empty scope, both connections, read + search", () => {
    const claims = verifyMissionToken(
      signDevToken({ key: KEY, ttlSeconds: 60 }),
      { key: KEY },
    );
    expect(claims.scope).toEqual({});
    expect(claims.connections).toEqual(["linear", "github"]);
    expect(claims.allow).toEqual(["read", "search"]);
  });

  it("honours the ttl", () => {
    const claims = verifyMissionToken(
      signDevToken({ key: KEY, ttlSeconds: 900 }),
      { key: KEY },
    );
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("refuses a weak key", () => {
    expect(() =>
      signDevToken({ key: Buffer.from("k".repeat(31)), ttlSeconds: 60 }),
    ).toThrow(/key/i);
  });
});

describe("ttl hard cap", () => {
  it("exposes the 60 minute cap", () => {
    expect(MAX_TTL_SECONDS).toBe(3600);
  });

  it("accepts a ttl exactly at the cap", () => {
    const claims = verifyMissionToken(
      signDevToken({ key: KEY, ttlSeconds: MAX_TTL_SECONDS }),
      { key: KEY },
    );
    expect(claims.exp - claims.iat).toBe(MAX_TTL_SECONDS);
  });

  it("rejects a ttl above the cap", () => {
    expect(() => signDevToken({ key: KEY, ttlSeconds: 3601 })).toThrow(/ttl/i);
    expect(() =>
      signMissionToken(MISSION, { key: KEY, ttlSeconds: 86_400 }),
    ).toThrow(/ttl/i);
  });

  it("rejects a zero or negative ttl", () => {
    expect(() => signDevToken({ key: KEY, ttlSeconds: 0 })).toThrow(/ttl/i);
    expect(() => signDevToken({ key: KEY, ttlSeconds: -1 })).toThrow(/ttl/i);
    expect(() =>
      signMissionToken(MISSION, { key: KEY, ttlSeconds: 0 }),
    ).toThrow(/ttl/i);
  });

  it("rejects a non-integer ttl", () => {
    expect(() => signDevToken({ key: KEY, ttlSeconds: 1.5 })).toThrow(/ttl/i);
    expect(() => signDevToken({ key: KEY, ttlSeconds: Number.NaN })).toThrow(
      /ttl/i,
    );
  });
});
