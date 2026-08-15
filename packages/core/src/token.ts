import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { LinkSystem } from "./entity-graph";

export interface MissionScope {
  customer?: string;
  repos?: string[];
  /**
   * A mission scoped DIRECTLY to one native id, with no entity behind it — the
   * shape an event hands you: a Zendesk webhook carries `organization_id`, not
   * a business name.
   *
   * It is single-system by construction: the graph may widen it to the other
   * systems of the entity that confirms this id, and can do nothing else. A
   * deployment with no graph at all still mints and still works, which is why
   * this field exists beside `customer` rather than being expressed through it.
   *
   * `customer` and `native` are mutually exclusive — see `scopeRequestFor`.
   */
  native?: { system: LinkSystem; id: string };
}

export interface MissionInput {
  id: string;
  purpose: string;
  /** Human (or service) accountable for the mission — provenance, never authz. */
  actor: string;
  scope: MissionScope;
  connections: string[];
  allow: readonly string[];
}

export interface MissionClaims extends MissionInput {
  jti: string;
  iat: number;
  exp: number;
}

/**
 * The one rejection that still knows a real mission: the signature is checked
 * before the clock, so claims reaching this error are verified claims, not a
 * bearer's unproven story. Carrying them lets a denial tell the agent that ITS
 * mission expired — a fact about its own grant, never about a target — where a
 * garbage token can only be answered with "unauthenticated".
 */
export class MissionExpiredError extends Error {
  readonly claims: MissionClaims;
  constructor(claims: MissionClaims) {
    super("token expired");
    this.name = "MissionExpiredError";
    this.claims = claims;
  }
}

const PREFIX = "msr_";
const MIN_KEY_BYTES = 32;

/**
 * Hard cap on mission lifetime (SPEC §4.2): 60 minutes. A mission is a
 * short-lived grant, so the cap lives here — at the only place that mints —
 * rather than in the callers, where one forgetful path would be enough to
 * hand out a near-eternal scope-all token.
 */
export const MAX_TTL_SECONDS = 3600;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

function assertKey(key: Buffer): void {
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(
      `signing key must be at least ${String(MIN_KEY_BYTES)} bytes`,
    );
  }
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** An array claim is valid only if every element is a string — no coercion. */
function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Fails closed: a missing or mistyped claim rejects the token, never defaults. */
function validateClaims(value: unknown): MissionClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid claims: payload");
  }
  const c = value as Record<string, unknown>;
  const checks: readonly (readonly [string, boolean])[] = [
    ["id", typeof c.id === "string"],
    ["purpose", typeof c.purpose === "string"],
    ["actor", typeof c.actor === "string"],
    ["jti", typeof c.jti === "string"],
    ["iat", isFiniteNumber(c.iat)],
    ["exp", isFiniteNumber(c.exp)],
    [
      "scope",
      typeof c.scope === "object" &&
        c.scope !== null &&
        !Array.isArray(c.scope),
    ],
    ["connections", isStringArray(c.connections)],
    ["allow", isStringArray(c.allow)],
  ];
  for (const [field, ok] of checks) {
    if (!ok) throw new Error(`invalid claims: ${field}`);
  }
  return value as MissionClaims;
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("ttl must be a positive integer number of seconds");
  }
  if (ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(
      `ttl must not exceed ${String(MAX_TTL_SECONDS)} seconds (60 minutes)`,
    );
  }
}

export function signMissionToken(
  mission: MissionInput,
  opts: { key: Buffer; ttlSeconds: number; now?: number },
): string {
  assertKey(opts.key);
  assertTtl(opts.ttlSeconds);
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: MissionClaims = {
    ...mission,
    jti: randomUUID(),
    iat,
    exp: iat + opts.ttlSeconds,
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64url(hmac(opts.key, payload));
  return `${PREFIX}${payload}.${sig}`;
}

export function verifyMissionToken(
  token: string,
  opts: { key: Buffer; now?: number },
): MissionClaims {
  assertKey(opts.key);
  if (!token.startsWith(PREFIX)) throw new Error("invalid token format");
  const body = token.slice(PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot < 0) throw new Error("invalid token format");
  const payload = body.slice(0, dot);
  const sig = Buffer.from(body.slice(dot + 1), "base64url");
  const expected = hmac(opts.key, payload);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    throw new Error("invalid signature");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid claims: payload");
  }
  const claims = validateClaims(parsed);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (claims.exp <= now) throw new MissionExpiredError(claims);
  return claims;
}

/**
 * M1 scope-all developer token. Real, scoped missions arrive in M2 — this
 * helper exists so the data plane can be exercised without a mission source,
 * and it grants only read/search on the two M1 connections.
 */
export function signDevToken(opts: {
  key: Buffer;
  ttlSeconds: number;
}): string {
  return signMissionToken(
    {
      id: "msn_dev",
      purpose: "m1 dev token — scope all",
      actor: "dev@local",
      scope: {},
      connections: ["linear", "github"],
      allow: ["read", "search"],
    },
    opts,
  );
}
