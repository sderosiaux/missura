import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  assertGrantable,
  OperationGapError,
  OperationGrantError,
  type FeasibilityReport,
  type MissionClaims,
  type MissionRecord,
  type MissionResolution,
  type MissionScope,
  type MissionStore,
} from "@missura/core";
import {
  approvalIdOf,
  APPROVALS_PATH,
  decideApproval,
  listApprovals,
} from "./operator-approvals";
import {
  FieldError,
  parseJson,
  readFeasibilityQuery,
  readMissionRequest,
} from "./operator-request";
import { DEFAULT_GITHUB_PORT, DEFAULT_LINEAR_PORT } from "./server";

/** Operator plane, deliberately apart from the two data planes. */
export const DEFAULT_OPERATOR_PORT = 8480;

/** Mission requests are small; anything larger is not one. */
export const MAX_OPERATOR_BODY_BYTES = 64 * 1024;

export interface OperatorDeps {
  store: MissionStore;
  /**
   * Turns a business scope into vendor targets through the entity graph; throws
   * on an unknown entity. It answers with the graph's account of the scope as
   * well as the scope, so a mission minted here records what the graph declined
   * to use — the operator plane must not be the one path that loses it.
   */
  resolve(scope: MissionScope): MissionResolution;
  /**
   * The gap report for an entity under a would-be grant (M9): what it can
   * run, and for the rest the one cause and the command that closes it. Read
   * from the same graph `resolve` reads, over every operation the product
   * knows. Throws on an unknown entity, like `resolve`.
   */
  feasibility(entity: string, allow: readonly string[]): FeasibilityReport;
  /** Compared against the presented bearer, never echoed anywhere. */
  operatorKey: Buffer;
  verifyToken(token: string): MissionClaims;
  proxyOrigins?: ProxyOrigins;
}

/**
 * Where the agent sends each connection. Zendesk is optional for the same
 * reason its listener is: an origin advertised for a connection this proxy does
 * not serve would point an agent at a closed port.
 */
export interface ProxyOrigins {
  linear: string;
  github: string;
  zendesk?: string;
}

interface MissionListing {
  id: string;
  purpose: string;
  actor: string;
  scope: MissionScope;
  expiresAt: number;
}

function defaultOrigins(): ProxyOrigins {
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

function mint(deps: OperatorDeps, body: Record<string, unknown>): unknown {
  const input = readMissionRequest(body);
  // Resolution runs before minting: a mission whose entity is unknown must not
  // exist at all, not exist and resolve to nothing at request time. What it
  // resolves to is also what decides the mission's connections.
  let resolved: MissionResolution;
  try {
    resolved = deps.resolve(input.scope);
  } catch (err) {
    throw new FieldError(
      "scope",
      err instanceof Error ? err.message : "unresolvable scope",
    );
  }
  // A name the entity cannot run is refused as its GAP, before the store is
  // asked: the 400 then says which link or connection to fix, not "unknown".
  // A name the catalogue does not hold at all is left to the store.
  const allow = input.allow ?? [];
  if (input.scope.entity !== undefined && allow.length > 0) {
    try {
      assertGrantable(deps.feasibility(input.scope.entity, allow), allow);
    } catch (err) {
      if (err instanceof OperationGapError) throw new FieldError("allow", err.message, err.gap);
      throw err;
    }
  }
  let created: { record: MissionRecord; token: string };
  try {
    created = deps.store.create(input, resolved.scope, resolved.resolution);
  } catch (err) {
    // A name the catalogue does not hold is the operator's field to fix,
    // named as such; anything else the store refuses is still a 500.
    if (err instanceof OperationGrantError) throw new FieldError("allow", err.message);
    throw err;
  }
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
  if (typeof token === "string" && token !== "") {
    let jti: string;
    try {
      jti = deps.verifyToken(token).jti;
    } catch {
      // Nothing to revoke: an unverifiable token was never a grant.
      return { revoked: true };
    }
    // Recorded on the jti, not on a record: the proxy honours the signature,
    // so a token whose record this store never saw is still live. A failure to
    // write is left to surface — answering `{revoked: true}` for a revocation
    // that did not land is the one lie this endpoint must not tell.
    deps.store.revokeJti(jti);
    return { revoked: true };
  }
  if (typeof missionId === "string" && missionId !== "") {
    try {
      deps.store.revoke(missionId);
    } catch {
      // An id names a record or nothing at all, and which one it is stays
      // unsaid: RFC 7009 again.
    }
    return { revoked: true };
  }
  throw new FieldError("token", "token or mission_id is required");
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

/**
 * The operator's whole view of an entity's reach: systems, link statuses,
 * commands. Served here and nowhere an agent can reach, for exactly that
 * reason. An unknown entity is the operator's field to fix, like the mint's.
 */
function feasibility(deps: OperatorDeps, query: URLSearchParams): FeasibilityReport {
  const { entity, allow } = readFeasibilityQuery(query);
  try {
    return deps.feasibility(entity, allow);
  } catch (err) {
    throw new FieldError("entity", err instanceof Error ? err.message : "unresolvable entity");
  }
}

function route(
  deps: OperatorDeps,
  method: string,
  url: URL,
  raw: string | undefined,
): { status: number; payload: unknown } {
  const path = url.pathname;
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
    if (method === "GET" && path === "/v1/feasibility") {
      return { status: 200, payload: feasibility(deps, url.searchParams) };
    }
    // The approvals (M10): read here, decided here, never run here.
    if (method === "GET" && path === APPROVALS_PATH) {
      return { status: 200, payload: listApprovals(deps.store) };
    }
    const approvalId = approvalIdOf(path);
    if (method === "POST" && approvalId !== undefined) {
      return { status: 200, payload: decideApproval(deps.store, approvalId, parseJson(raw)) };
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
            ...(err.gap === undefined ? {} : { gap: err.gap }),
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
        // The origin is a placeholder: only the path and the query are read.
        const url = new URL(req.url ?? "/", "http://operator.invalid");
        const out = route(deps, req.method ?? "GET", url, raw);
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
