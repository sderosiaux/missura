import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { MAX_TTL_SECONDS } from "@missura/core";
import type {
  CreateMission,
  MissionClaims,
  MissionRecord,
  MissionScope,
  MissionStore,
  ResolvedScope,
} from "@missura/core";
import { DEFAULT_GITHUB_PORT, DEFAULT_LINEAR_PORT } from "./server";

/** Operator plane, deliberately apart from the two data planes. */
export const DEFAULT_OPERATOR_PORT = 8480;

/** Mission requests are small; anything larger is not one. */
export const MAX_OPERATOR_BODY_BYTES = 64 * 1024;

export interface OperatorDeps {
  store: MissionStore;
  /** Turns a business scope into vendor targets; throws on an unknown entity. */
  resolve(scope: MissionScope): ResolvedScope;
  /** Compared against the presented bearer, never echoed anywhere. */
  operatorKey: Buffer;
  verifyToken(token: string): MissionClaims;
  proxyOrigins?: { linear: string; github: string };
}

interface MissionListing {
  id: string;
  purpose: string;
  actor: string;
  scope: MissionScope;
  expiresAt: number;
}

/** A validation failure that names the field the operator got wrong. */
class FieldError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(reason);
    this.field = field;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultOrigins(): { linear: string; github: string } {
  return {
    linear: `http://127.0.0.1:${String(DEFAULT_LINEAR_PORT)}`,
    github: `http://127.0.0.1:${String(DEFAULT_GITHUB_PORT)}`,
  };
}

/**
 * Constant-time comparison of the presented bearer against the operator key.
 * A length mismatch or a non-hex string is refused before the compare — the
 * key is never quoted back, not in an error and not in a log line.
 */
function authorized(deps: OperatorDeps, header: string | undefined): boolean {
  if (header === undefined) return false;
  const prefix = "bearer ";
  if (!header.toLowerCase().startsWith(prefix)) return false;
  const hex = header.slice(prefix.length).trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== deps.operatorKey.length * 2)
    return false;
  return timingSafeEqual(Buffer.from(hex, "hex"), deps.operatorKey);
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OPERATOR_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      resolve(overflow ? undefined : Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  res.end(body);
}

function parseJson(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) throw new FieldError("body", "request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FieldError("body", "request body is not valid JSON");
  }
  if (!isRecord(parsed))
    throw new FieldError("body", "request body must be a JSON object");
  return parsed;
}

function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FieldError(field, `${field} must be a non-empty string`);
  }
  return value;
}

function readScope(value: unknown): MissionScope {
  if (!isRecord(value))
    throw new FieldError("scope", "scope must be an object");
  const scope: MissionScope = {};
  if (value.customer !== undefined) {
    scope.customer = requireText("scope", value.customer);
  }
  if (value.repos !== undefined) {
    if (
      !Array.isArray(value.repos) ||
      value.repos.some((repo) => typeof repo !== "string")
    ) {
      throw new FieldError("scope", "scope.repos must be an array of strings");
    }
    scope.repos = value.repos as string[];
  }
  // Deny by default: a mission with no target is a scope-all mission.
  if (scope.customer === undefined && (scope.repos ?? []).length === 0) {
    throw new FieldError("scope", "scope must name a customer or repos");
  }
  return scope;
}

function readTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new FieldError("ttl", "ttl must be a positive integer of seconds");
  }
  // The cap is enforced again at minting time (core); refusing it here is what
  // turns it into a named field error instead of an opaque 500.
  if (value > MAX_TTL_SECONDS) {
    throw new FieldError(
      "ttl",
      `ttl must not exceed ${String(MAX_TTL_SECONDS)} seconds`,
    );
  }
  return value;
}

/**
 * RFC 9396-shaped mission request. The details entry is the grant: anything
 * that is not a single `type: "mission"` entry is refused rather than
 * interpreted — an operator plane guesses at nothing.
 */
function readMissionRequest(body: Record<string, unknown>): CreateMission {
  if (body.grant_type !== "client_credentials") {
    throw new FieldError("grant_type", "grant_type must be client_credentials");
  }
  const details = body.authorization_details;
  if (!Array.isArray(details) || details.length !== 1) {
    throw new FieldError(
      "authorization_details",
      "authorization_details must hold exactly one mission entry",
    );
  }
  const entry: unknown = details[0];
  if (!isRecord(entry) || entry.type !== "mission") {
    throw new FieldError(
      "authorization_details",
      'authorization_details[0].type must be "mission"',
    );
  }
  return {
    purpose: requireText("purpose", entry.purpose),
    actor: requireText("actor", entry.actor),
    scope: readScope(entry.scope),
    ttlSeconds: readTtl(entry.ttl),
  };
}

function mint(deps: OperatorDeps, body: Record<string, unknown>): unknown {
  const input = readMissionRequest(body);
  // Resolution runs before minting: a mission whose entity is unknown must not
  // exist at all, not exist and resolve to nothing at request time.
  try {
    deps.resolve(input.scope);
  } catch (err) {
    throw new FieldError(
      "scope",
      err instanceof Error ? err.message : "unresolvable scope",
    );
  }
  const created: { record: MissionRecord; token: string } =
    deps.store.create(input);
  return {
    mission_id: created.record.id,
    access_token: created.token,
    expires_in: created.record.expiresAt - created.record.createdAt,
    proxy_origins: deps.proxyOrigins ?? defaultOrigins(),
  };
}

/**
 * RFC 7009 semantics: revocation is idempotent and never a lookup oracle. An
 * unknown token or id answers exactly like a successful revoke, so a caller
 * learns nothing about which missions exist.
 */
function revoke(deps: OperatorDeps, body: Record<string, unknown>): unknown {
  const token = body.token;
  const missionId = body.mission_id;
  let key: string;
  if (typeof token === "string" && token !== "") {
    try {
      key = deps.verifyToken(token).jti;
    } catch {
      return { revoked: true };
    }
  } else if (typeof missionId === "string" && missionId !== "") {
    key = missionId;
  } else {
    throw new FieldError("token", "token or mission_id is required");
  }
  try {
    deps.store.revoke(key);
  } catch {
    return { revoked: true };
  }
  return { revoked: true };
}

/** Description of a grant only: no jti, no token, nothing bearer-shaped. */
function listing(deps: OperatorDeps): { missions: MissionListing[] } {
  return {
    missions: deps.store.active().map((m) => ({
      id: m.id,
      purpose: m.purpose,
      actor: m.actor,
      scope: m.scope,
      expiresAt: m.expiresAt,
    })),
  };
}

function route(
  deps: OperatorDeps,
  method: string,
  path: string,
  raw: string | undefined,
): { status: number; payload: unknown } {
  try {
    if (method === "POST" && path === "/v1/token") {
      return { status: 200, payload: mint(deps, parseJson(raw)) };
    }
    if (method === "POST" && path === "/v1/revoke") {
      return { status: 200, payload: revoke(deps, parseJson(raw)) };
    }
    if (method === "GET" && path === "/v1/missions") {
      return { status: 200, payload: listing(deps) };
    }
    return { status: 404, payload: { error: { code: "missura_not_found" } } };
  } catch (err) {
    if (err instanceof FieldError) {
      return {
        status: 400,
        payload: {
          error: {
            code: "missura_invalid_request",
            field: err.field,
            reason: err.message,
          },
        },
      };
    }
    throw err;
  }
}

export function createOperatorServer(deps: OperatorDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const raw = await readBody(req);
        // Authn before routing: an unauthenticated caller cannot even learn
        // which operator routes exist.
        if (!authorized(deps, req.headers.authorization)) {
          send(res, 401, { error: { code: "missura_unauthorized" } });
          return;
        }
        const path = (req.url ?? "/").split("?")[0] ?? "/";
        const out = route(deps, req.method ?? "GET", path, raw);
        send(res, out.status, out.payload);
      } catch {
        send(res, 500, { error: { code: "missura_internal" } });
      }
    })();
  });
}

export async function startOperatorServer(
  deps: OperatorDeps,
  port: number = DEFAULT_OPERATOR_PORT,
): Promise<Server> {
  const server = createOperatorServer(deps);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  return server;
}
