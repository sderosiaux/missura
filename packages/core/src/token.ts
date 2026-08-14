import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface MissionScope {
  customer?: string;
  repos?: string[];
}

export interface MissionInput {
  id: string;
  purpose: string;
  scope: MissionScope;
  connections: string[];
  allow: readonly string[];
}

export interface MissionClaims extends MissionInput {
  jti: string;
  iat: number;
  exp: number;
}

const PREFIX = "msr_";
const MIN_KEY_BYTES = 32;

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

/** Fails closed: a missing or mistyped claim rejects the token, never defaults. */
function validateClaims(value: unknown): MissionClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid claims: payload");
  }
  const c = value as Record<string, unknown>;
  const checks: readonly (readonly [string, boolean])[] = [
    ["id", typeof c.id === "string"],
    ["purpose", typeof c.purpose === "string"],
    ["jti", typeof c.jti === "string"],
    ["iat", isFiniteNumber(c.iat)],
    ["exp", isFiniteNumber(c.exp)],
    [
      "scope",
      typeof c.scope === "object" &&
        c.scope !== null &&
        !Array.isArray(c.scope),
    ],
    ["connections", Array.isArray(c.connections)],
    ["allow", Array.isArray(c.allow)],
  ];
  for (const [field, ok] of checks) {
    if (!ok) throw new Error(`invalid claims: ${field}`);
  }
  return value as MissionClaims;
}

export function signMissionToken(
  mission: MissionInput,
  opts: { key: Buffer; ttlSeconds: number; now?: number },
): string {
  assertKey(opts.key);
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
  if (claims.exp <= now) throw new Error("token expired");
  return claims;
}
