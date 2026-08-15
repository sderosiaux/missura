import type {
  CatalogDecision,
  DecisionEvent,
  MissionClaims,
  Provider,
} from "@missura/core";

/** One inbound request, already read off the wire (headers lowercased). */
export interface IncomingShape {
  method: string;
  /** Path plus query string, exactly as the client sent it. */
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ResponseShape {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export interface PipelineDeps {
  provider: Provider;
  verifyToken(token: string): MissionClaims;
  decide(req: { method: string; path: string; body: string }): CatalogDecision;
  /** The vendor credential, read from the vault once at boot — never logged. */
  vendorAuthHeader(): string;
  upstreamBase: string;
  fetchImpl: typeof fetch;
  emit(ev: DecisionEvent): void;
  now?(): number;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json",
};

/**
 * Headers the proxy never forwards. `authorization` is replaced by the vendor
 * credential and `host` must be recomputed by the client for the upstream
 * origin; the rest are hop-by-hop or connection-scoped and would describe the
 * agent's connection, not ours (a stale `content-length` in particular would
 * contradict the body we re-send). `accept-encoding` is dropped so the fetch
 * implementation owns the negotiation — we hand back a decoded body without a
 * `content-encoding` header.
 */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

/** The only upstream response headers echoed back: no cookies, no vendor metadata. */
const FORWARDED_RESPONSE_HEADERS: readonly string[] = ["content-type"];

const BEARER = "bearer ";

function errorBody(code: string, reason?: string): string {
  return JSON.stringify({
    error: reason === undefined ? { code } : { code, reason },
  });
}

function jsonError(
  status: number,
  code: string,
  reason?: string,
): ResponseShape {
  return {
    status,
    headers: { ...JSON_HEADERS },
    body: errorBody(code, reason),
  };
}

function bearerToken(headers: Record<string, string>): string | undefined {
  const raw = headers.authorization;
  if (raw === undefined) return undefined;
  if (!raw.toLowerCase().startsWith(BEARER)) return undefined;
  const token = raw.slice(BEARER.length).trim();
  return token.length === 0 ? undefined : token;
}

function upstreamHeaders(
  deps: PipelineDeps,
  req: IncomingShape,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase()))
      out[name.toLowerCase()] = value;
  }
  out.authorization = deps.vendorAuthHeader();
  return out;
}

function hasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

/**
 * The audit record is part of the answer, not a side effect: if it cannot be
 * written the request fails closed (500) rather than serving an unlogged
 * decision. Callers therefore let `emit` throw.
 */
function emitEvent(
  deps: PipelineDeps,
  input: {
    decision: CatalogDecision;
    missionId: string;
    startedAt: number;
    reason?: string;
  },
): void {
  const now = deps.now?.() ?? Date.now();
  deps.emit({
    ts: new Date(now).toISOString(),
    provider: deps.provider,
    operation: input.decision.operation,
    action: input.decision.action,
    decision: input.decision.decision,
    reason: input.reason ?? input.decision.reason,
    missionId: input.missionId,
    latencyMs: Math.max(0, now - input.startedAt),
  });
}

/** Reason for every request target that would leave the connector's origin. */
const ESCAPE_REASON = "path escapes upstream origin";
const CONNECTION_REASON = "connection not in mission";
const ACTION_REASON = "action not allowed by mission";

/** A claims denial keeps the catalog's operation/action so the log stays readable. */
function claimsDenial(
  verdict: CatalogDecision,
  reason: string,
): CatalogDecision {
  return { ...verdict, decision: "deny", reason };
}

const UNKNOWN_VERDICT: CatalogDecision = {
  decision: "deny",
  operation: "unknown",
  action: "unknown",
  reason: "unknown",
};

/**
 * Resolves the request target against the upstream base instead of
 * concatenating it. A client may send an absolute (`https://evil.com/x`) or
 * protocol-relative (`//evil.com/x`) request target; string concatenation
 * would hand that origin the injected vendor credential. Anything that does
 * not resolve back onto the upstream origin is refused.
 */
function upstreamTarget(deps: PipelineDeps, path: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(path, deps.upstreamBase);
    if (url.origin !== new URL(deps.upstreamBase).origin) return undefined;
  } catch {
    return undefined;
  }
  return url;
}

async function forward(
  deps: PipelineDeps,
  target: URL,
  req: IncomingShape,
  verdict: CatalogDecision,
  missionId: string,
  startedAt: number,
): Promise<ResponseShape> {
  let response: Response;
  try {
    // Origin + the normalized target only: never the raw client path, and
    // never a fragment (which does not belong on the wire).
    const url = `${target.origin}${target.pathname}${target.search}`;
    response = await deps.fetchImpl(url, {
      method: req.method,
      headers: upstreamHeaders(deps, req),
      ...(hasBody(req.method) && req.body.length > 0 ? { body: req.body } : {}),
    });
  } catch {
    // The upstream error is deliberately swallowed: its message can carry the
    // vendor host, and an injected credential could surface in a wrapped error.
    emitEvent(deps, {
      decision: verdict,
      missionId,
      startedAt,
      reason: "upstream_error",
    });
    return jsonError(502, "missura_upstream_error");
  }

  const payload = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  emitEvent(deps, { decision: verdict, missionId, startedAt });
  return { status: response.status, headers, body: payload };
}

/**
 * authn → catalog → vendor credential injection → forward → audit.
 *
 * Deny by default at every step: the upstream is reached only after a mission
 * token verified and a catalog ALLOW, and any thrown error (catalog, audit
 * sink, bug) becomes a 500 instead of falling through to the vendor.
 */
export async function handle(
  deps: PipelineDeps,
  req: IncomingShape,
): Promise<ResponseShape> {
  const startedAt = deps.now?.() ?? Date.now();
  try {
    const token = bearerToken(req.headers);
    let claims: MissionClaims | undefined;
    if (token !== undefined) {
      try {
        claims = deps.verifyToken(token);
      } catch {
        claims = undefined;
      }
    }
    if (claims === undefined) {
      emitEvent(deps, {
        decision: {
          decision: "deny",
          operation: "unknown",
          action: "unknown",
          reason: "authn: missing or invalid mission token",
        },
        missionId: "unknown",
        startedAt,
      });
      return jsonError(401, "missura_unauthorized");
    }

    // The mission decides which connections it may touch. Separate ports are a
    // convenience, not a boundary: a token minted for one connection must not
    // work against another listener just because the agent aimed at its port.
    if (!claims.connections.includes(deps.provider)) {
      emitEvent(deps, {
        decision: claimsDenial(UNKNOWN_VERDICT, CONNECTION_REASON),
        missionId: claims.id,
        startedAt,
      });
      return jsonError(403, "missura_denied", CONNECTION_REASON);
    }

    const verdict = deps.decide({
      method: req.method,
      path: req.path,
      body: req.body,
    });
    if (verdict.decision === "deny") {
      emitEvent(deps, { decision: verdict, missionId: claims.id, startedAt });
      return jsonError(403, "missura_denied", verdict.reason);
    }

    // The catalog says what the connector can serve; the mission says what
    // this agent may do with it. An ALLOW the mission does not cover is a deny.
    if (!claims.allow.includes(verdict.action)) {
      emitEvent(deps, {
        decision: claimsDenial(verdict, ACTION_REASON),
        missionId: claims.id,
        startedAt,
      });
      return jsonError(403, "missura_denied", ACTION_REASON);
    }

    const target = upstreamTarget(deps, req.path);
    if (target === undefined) {
      emitEvent(deps, {
        decision: { ...verdict, decision: "deny", reason: ESCAPE_REASON },
        missionId: claims.id,
        startedAt,
      });
      return jsonError(403, "missura_denied", ESCAPE_REASON);
    }

    return await forward(deps, target, req, verdict, claims.id, startedAt);
  } catch {
    // Never echo the internal error: it may quote the request or the vendor.
    return jsonError(500, "missura_internal");
  }
}
