import type {
  CatalogDecision,
  DecisionEvent,
  MissionClaims,
  Provider,
} from "@missura/core";
import {
  applyPostCheck,
  GITHUB_NOT_FOUND_BODY,
  OUT_OF_SCOPE_REASON,
  type NarrowFn,
  type NarrowPostCheck,
} from "./narrow";
import { traceIdOf } from "./trace";
import {
  bearerToken,
  errorBody,
  FORWARDED_RESPONSE_HEADERS,
  hasBody,
  JSON_HEADERS,
  readCapped,
  upstreamHeaders,
} from "./transport";

export { MAX_RESPONSE_BYTES } from "./transport";

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
  /**
   * Consulted on every request, never cached: a revoked mission must stop
   * working on the very next call, not at the next token expiry.
   */
  isRevoked(jti: string): boolean;
  /** The connector's NARROW: rewrites, denies, or registers a post-check. */
  narrow: NarrowFn;
  /** The vendor credential, read from the vault once at boot — never logged. */
  vendorAuthHeader(): string;
  upstreamBase: string;
  fetchImpl: typeof fetch;
  emit(ev: DecisionEvent): void;
  now?(): number;
}

/** Reason recorded when the vendor answered but the answer was refused. */
const TOO_LARGE_REASON = "response too large (after upstream call)";

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

/**
 * Everything the audit record knows about the request that is not the verdict:
 * who (`actor`), what for (`purpose`) and the caller's trace, filled in as
 * soon as the claims are verified.
 */
interface RequestContext {
  missionId: string;
  startedAt: number;
  actor?: string;
  purpose?: string;
  traceId?: string;
}

/**
 * The audit record is part of the answer, not a side effect: if it cannot be
 * written the request fails closed (500) rather than serving an unlogged
 * decision. Callers therefore let `emit` throw.
 */
function emitEvent(
  deps: PipelineDeps,
  ctx: RequestContext,
  decision: CatalogDecision,
  reason?: string,
): void {
  const now = deps.now?.() ?? Date.now();
  deps.emit({
    ts: new Date(now).toISOString(),
    provider: deps.provider,
    operation: decision.operation,
    action: decision.action,
    decision: decision.decision,
    reason: reason ?? decision.reason,
    missionId: ctx.missionId,
    latencyMs: Math.max(0, now - ctx.startedAt),
    ...(ctx.actor === undefined ? {} : { actor: ctx.actor }),
    ...(ctx.purpose === undefined ? {} : { purpose: ctx.purpose }),
    ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
  });
}

/** Reason for every request target that would leave the connector's origin. */
const ESCAPE_REASON = "path escapes upstream origin";
const CONNECTION_REASON = "connection not in mission";
const REVOKED_REASON = "revoked";
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
  ctx: RequestContext,
  postCheck?: NarrowPostCheck,
): Promise<ResponseShape> {
  let response: Response;
  try {
    // Origin + the normalized target only: never the raw client path, and
    // never a fragment (which does not belong on the wire).
    const url = `${target.origin}${target.pathname}${target.search}`;
    response = await deps.fetchImpl(url, {
      method: req.method,
      headers: upstreamHeaders(req.headers, deps.vendorAuthHeader()),
      ...(hasBody(req.method) && req.body.length > 0 ? { body: req.body } : {}),
    });
  } catch {
    // The upstream error is deliberately swallowed: its message can carry the
    // vendor host, and an injected credential could surface in a wrapped error.
    emitEvent(deps, ctx, verdict, "upstream_error");
    return jsonError(502, "missura_upstream_error");
  }

  const payload = await readCapped(response);
  if (payload === undefined) {
    // The vendor was reached, so the record says so — the request is denied
    // on the way back, not on the way out.
    emitEvent(
      deps,
      ctx,
      { ...verdict, decision: "deny", reason: TOO_LARGE_REASON },
      TOO_LARGE_REASON,
    );
    return jsonError(502, "missura_response_too_large");
  }
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  if (postCheck !== undefined) {
    const checked = applyPostCheck(
      postCheck,
      new TextDecoder().decode(payload),
    );
    if (!checked.ok) {
      emitEvent(
        deps,
        ctx,
        { ...verdict, decision: "deny", reason: OUT_OF_SCOPE_REASON },
        OUT_OF_SCOPE_REASON,
      );
      return {
        status: response.status,
        headers: { ...JSON_HEADERS },
        body: checked.body,
      };
    }
    emitEvent(deps, ctx, verdict);
    return { status: response.status, headers, body: checked.body };
  }

  emitEvent(deps, ctx, verdict);
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
  const traceId = traceIdOf(req.headers.traceparent);
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
    const anonymous: RequestContext = {
      missionId: "unknown",
      startedAt,
      ...(traceId === undefined ? {} : { traceId }),
    };
    if (claims === undefined) {
      emitEvent(deps, anonymous, {
        decision: "deny",
        operation: "unknown",
        action: "unknown",
        reason: "authn: missing or invalid mission token",
      });
      return jsonError(401, "missura_unauthorized");
    }

    const ctx: RequestContext = {
      missionId: claims.id,
      startedAt,
      actor: claims.actor,
      purpose: claims.purpose,
      ...(traceId === undefined ? {} : { traceId }),
    };

    // A signature that still verifies says nothing about a mission an operator
    // has since called back. The list is read here, per request, so a revoke
    // lands on the next call rather than at expiry.
    if (deps.isRevoked(claims.jti)) {
      emitEvent(
        deps,
        ctx,
        claimsDenial(UNKNOWN_VERDICT, REVOKED_REASON),
        REVOKED_REASON,
      );
      return jsonError(401, "missura_unauthorized", REVOKED_REASON);
    }

    // The mission decides which connections it may touch. Separate ports are a
    // convenience, not a boundary: a token minted for one connection must not
    // work against another listener just because the agent aimed at its port.
    if (!claims.connections.includes(deps.provider)) {
      emitEvent(deps, ctx, claimsDenial(UNKNOWN_VERDICT, CONNECTION_REASON));
      return jsonError(403, "missura_denied", CONNECTION_REASON);
    }

    const verdict = deps.decide({
      method: req.method,
      path: req.path,
      body: req.body,
    });
    if (verdict.decision === "deny") {
      emitEvent(deps, ctx, verdict);
      return jsonError(403, "missura_denied", verdict.reason);
    }

    // The catalog says what the connector can serve; the mission says what
    // this agent may do with it. An ALLOW the mission does not cover is a deny.
    if (!claims.allow.includes(verdict.action)) {
      emitEvent(deps, ctx, claimsDenial(verdict, ACTION_REASON));
      return jsonError(403, "missura_denied", ACTION_REASON);
    }

    // NARROW runs last, on an already-cataloged request: it shrinks what the
    // agent asked for to what the mission proves it may see.
    const narrowed = deps.narrow(
      { method: req.method, path: req.path, body: req.body },
      claims,
    );
    if (narrowed.decision === "deny") {
      const reason = narrowed.reason ?? "narrowed out of mission scope";
      emitEvent(deps, ctx, claimsDenial(verdict, reason), reason);
      return narrowed.denyShape === "github404"
        ? {
            status: 404,
            headers: { ...JSON_HEADERS },
            body: GITHUB_NOT_FOUND_BODY,
          }
        : jsonError(403, "missura_denied", reason);
    }
    const outbound: IncomingShape = {
      ...req,
      path: narrowed.path ?? req.path,
      body: narrowed.body ?? req.body,
    };

    // Re-resolved from the rewritten target: NARROW is trusted to shrink a
    // request, never to move it to another origin.
    const target = upstreamTarget(deps, outbound.path);
    if (target === undefined) {
      emitEvent(
        deps,
        ctx,
        { ...verdict, decision: "deny", reason: ESCAPE_REASON },
        ESCAPE_REASON,
      );
      return jsonError(403, "missura_denied", ESCAPE_REASON);
    }

    return await forward(
      deps,
      target,
      outbound,
      verdict,
      ctx,
      narrowed.postCheck,
    );
  } catch {
    // Never echo the internal error: it may quote the request or the vendor.
    return jsonError(500, "missura_internal");
  }
}
