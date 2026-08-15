import type { CatalogDecision, MissionClaims } from "@missura/core";
import {
  ACTION_REASON,
  CONNECTION_REASON,
  claimsDenial,
  emitEvent,
  ESCAPE_REASON,
  REVOKED_REASON,
  UNKNOWN_VERDICT,
  type RequestContext,
} from "./audit";
import { forward, upstreamTarget, type ForwardDeps } from "./forward";
import { GITHUB_NOT_FOUND_BODY, type NarrowFn } from "./narrow";
import { traceIdOf } from "./trace";
import {
  bearerToken,
  jsonError,
  JSON_HEADERS,
  type IncomingShape,
  type ResponseShape,
} from "./transport";

export { MAX_RESPONSE_BYTES } from "./transport";
export type { IncomingShape, ResponseShape } from "./transport";

export interface PipelineDeps extends ForwardDeps {
  verifyToken(token: string): MissionClaims;
  decide(req: { method: string; path: string; body: string }): CatalogDecision;
  /**
   * Consulted on every request, never cached: a revoked mission must stop
   * working on the very next call, not at the next token expiry.
   */
  isRevoked(jti: string): boolean;
  /** The connector's NARROW: rewrites, denies, or registers a post-check. */
  narrow: NarrowFn;
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
