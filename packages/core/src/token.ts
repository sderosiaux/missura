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

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

export function signMissionToken(
  mission: MissionInput,
  opts: { key: Buffer; ttlSeconds: number; now?: number },
): string {
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
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as MissionClaims;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (claims.exp <= now) throw new Error("token expired");
  return claims;
}
