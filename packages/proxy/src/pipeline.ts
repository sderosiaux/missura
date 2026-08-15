import {
  MissionExpiredError,
  type CatalogDecision,
  type CursorStore,
  type MissionClaims,
} from "@missura/core";
import {
  ACTION_REASON,
  CONNECTION_REASON,
  CURSOR_REASON,
  claimsDenial,
  emitEvent,
  ESCAPE_REASON,
  EXPIRED_REASON,
  REVOKED_REASON,
  UNAUTHENTICATED_REASON,
  UNKNOWN_VERDICT,
  type RequestContext,
} from "./audit";
import { withMissuraCursor, withVendorCursor } from "./cursor-swap";
import { denialResponse, type DenialOptions } from "./deny";
import { filterTask } from "./filter";
import { forward, upstreamTarget, type ForwardDeps } from "./forward";
import { GITHUB_NOT_FOUND_MESSAGE, type NarrowFn } from "./narrow";
import { refill } from "./refill";
import { traceIdOf } from "./trace";
import {
  bearerToken,
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
  /**
   * Where the vendor's pagination positions are kept so the agent never holds
   * one (SPEC §22). Required: defaulting it away would hand back vendor cursors
   * again, and the length of the walk they encode is a count of hidden objects.
   */
  cursors: CursorStore;
}

/**
 * A token that fails to verify says nothing — except when it fails on the
 * clock. The signature is checked before the expiry, so an expired mission is
 * the one rejection that still knows a real grant, and the agent can be told
 * "your mission expired, ask the operator" instead of the useless "invalid
 * token" a forged bearer gets.
 */
function verified(
  deps: PipelineDeps,
  token: string | undefined,
): {
  claims?: MissionClaims;
  expired?: MissionClaims;
} {
  if (token === undefined) return {};
  try {
    return { claims: deps.verifyToken(token) };
  } catch (err) {
    return err instanceof MissionExpiredError ? { expired: err.claims } : {};
  }
}

/**
 * authn → revocation → connections → catalog → action → narrow → origin
 * re-validation → forward → filter → audit.
 *
 * Deny by default at every step: the upstream is reached only after a mission
 * token verified and a catalog ALLOW, and any thrown error (catalog, audit
 * sink, bug) becomes a 500 instead of falling through to the vendor.
 *
 * Every refusal leaves through `denialResponse`, in the vendor's own envelope
 * with an actionable missura block attached (SPEC §4.8bis) — a refusal an SDK
 * cannot parse never reaches the agent that has to act on it.
 */
export async function handle(
  deps: PipelineDeps,
  req: IncomingShape,
): Promise<ResponseShape> {
  const startedAt = deps.now?.() ?? Date.now();
  const traceId = traceIdOf(req.headers.traceparent);
  const deny = (options: DenialOptions): ResponseShape =>
    denialResponse(deps.provider, options);
  try {
    const { claims, expired } = verified(deps, bearerToken(req.headers));
    const anonymous: RequestContext = {
      missionId: expired?.id ?? "unknown",
      startedAt,
      ...(traceId === undefined ? {} : { traceId }),
    };
    if (claims === undefined) {
      const reason =
        expired === undefined ? UNAUTHENTICATED_REASON : EXPIRED_REASON;
      emitEvent(deps, anonymous, {
        decision: "deny",
        operation: "unknown",
        action: "unknown",
        reason,
      });
      return deny({
        status: 401,
        code:
          expired === undefined
            ? "missura_unauthenticated"
            : "missura_mission_expired",
        reason,
        claims: expired,
        now: startedAt,
      });
    }

    const ctx: RequestContext = {
      missionId: claims.id,
      startedAt,
      actor: claims.actor,
      purpose: claims.purpose,
      ...(traceId === undefined ? {} : { traceId }),
    };
    const mission = { claims, now: startedAt };

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
      return deny({
        status: 401,
        code: "missura_mission_revoked",
        reason: REVOKED_REASON,
        ...mission,
      });
    }

    // The mission decides which connections it may touch. Separate ports are a
    // convenience, not a boundary: a token minted for one connection must not
    // work against another listener just because the agent aimed at its port.
    if (!claims.connections.includes(deps.provider)) {
      emitEvent(deps, ctx, claimsDenial(UNKNOWN_VERDICT, CONNECTION_REASON));
      return deny({
        status: 403,
        code: "missura_connection_not_in_mission",
        reason: CONNECTION_REASON,
        ...mission,
      });
    }

    const verdict = deps.decide({
      method: req.method,
      path: req.path,
      body: req.body,
    });
    if (verdict.decision === "deny") {
      emitEvent(deps, ctx, verdict);
      return deny({
        status: 403,
        code: "missura_operation_not_in_catalog",
        reason: verdict.reason,
        ...mission,
      });
    }

    // The catalog says what the connector can serve; the mission says what
    // this agent may do with it. An ALLOW the mission does not cover is a deny.
    if (!claims.allow.includes(verdict.action)) {
      emitEvent(deps, ctx, claimsDenial(verdict, ACTION_REASON));
      return deny({
        status: 403,
        code: "missura_action_not_allowed",
        reason: ACTION_REASON,
        requiredAction: verdict.action,
        ...mission,
      });
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
      const github404 = narrowed.denyShape === "github404";
      return deny({
        status: github404 ? 404 : 403,
        code: narrowed.denialCode ?? "missura_out_of_mission_scope",
        reason,
        // The vendor's own absence message, unchanged: a repo outside the
        // mission and a repo that never existed answer the same bytes.
        ...(github404 ? { vendorMessage: GITHUB_NOT_FOUND_MESSAGE } : {}),
        scopeSize: narrowed.missionScopeSize,
        ...mission,
      });
    }
    // The agent paginates with handles of ours, never with vendor positions.
    // One we did not issue to THIS mission is refused here rather than
    // forwarded: it would resume the walk somewhere nothing authorized.
    const outbound = withVendorCursor(
      {
        ...req,
        path: narrowed.path ?? req.path,
        body: narrowed.body ?? req.body,
      },
      narrowed.filterPlan,
      claims.id,
      deps.cursors,
    );
    if (outbound === undefined) {
      emitEvent(deps, ctx, claimsDenial(verdict, CURSOR_REASON), CURSOR_REASON);
      return deny({
        status: 403,
        code: "missura_out_of_mission_scope",
        reason: CURSOR_REASON,
        ...mission,
      });
    }

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
      return deny({
        status: 403,
        code: "missura_invalid_target",
        reason: ESCAPE_REASON,
        ...mission,
      });
    }

    // FILTER runs last, on the vendor's answer: the request was allowed to run,
    // and what comes back is cut down to what the mission proves it may see.
    // REFILL then repairs the page filtering made short — bounded, and through
    // this same `forward`, so there is one path to the vendor and one audit
    // record per call.
    const filter = filterTask(narrowed);
    const answer = await forward(
      deps,
      target,
      outbound,
      verdict,
      ctx,
      filter,
      claims,
    );
    const served = await refill(
      deps,
      { req: outbound, verdict, ctx, filter, claims },
      answer,
    );
    // Last, and on every response the rule describes: the vendor's position is
    // replaced by a handle. Doing it only on a walked answer would make the
    // cursor's own format say that a walk happened.
    return withMissuraCursor(
      served,
      narrowed.filterPlan,
      claims.id,
      deps.cursors,
    );
  } catch {
    // Never echo the internal error: it may quote the request or the vendor.
    return deny({
      status: 500,
      code: "missura_internal",
      reason: "missura failed while deciding this request",
    });
  }
}
