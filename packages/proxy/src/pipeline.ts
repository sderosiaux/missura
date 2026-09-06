import {
  actionCovered,
  MissionExpiredError,
  type CatalogRequest,
  type CursorStore,
  type MissionClaims,
  type ViaOperation,
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
import {
  actionDenial,
  connectionDenial,
  denialResponse,
  type DenialOptions,
} from "./deny";
import { filterTask } from "./filter";
import { forward, upstreamTarget, type ForwardDeps } from "./forward";
import {
  INTROSPECTION_VERDICT,
  introspectionResponse,
  isIntrospection,
} from "./introspect";
import { scopeDenial, type NarrowFn } from "./narrow";
import {
  executeOperation,
  operationName,
  type OperationsDeps,
} from "./operations";
import { parentProofStage, type ParentProofDeps } from "./parent-proof";
import { markReduced } from "./reduced";
import { refill } from "./refill";
import { traceIdOf } from "./trace";
import {
  bearerToken,
  type IncomingShape,
  type ResponseShape,
} from "./transport";

export { MAX_RESPONSE_BYTES } from "./transport";
export type { IncomingShape, ResponseShape } from "./transport";

export interface PipelineDeps extends ForwardDeps, ParentProofDeps {
  verifyToken(token: string): MissionClaims;
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
  /**
   * The operations this proxy serves (`operations.ts`). Required rather than
   * defaulted to an empty catalogue: a listener wired without one would answer
   * introspection with "no operations" for a proxy that has some.
   */
  operations: OperationsDeps;
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
 * re-validation → parent proof → forward → filter → audit.
 *
 * Deny by default at every step: the upstream is reached only after a mission
 * token verified and a catalog ALLOW, and any thrown error (catalog, audit
 * sink, bug) becomes a 500 instead of falling through to the vendor.
 *
 * Every refusal leaves through `denialResponse`, in the vendor's own envelope
 * with an actionable missura block attached (SPEC §4.8bis) — a refusal an SDK
 * cannot parse never reaches the agent that has to act on it.
 *
 * `via` is set on the inner calls of an operation (`operations.ts`) and on
 * nothing else — the listener never passes one, so a request off the wire
 * cannot carry it. It names the operation on this request's audit records,
 * and it is the ONE thing that can open a write route (M8): the catalog sees
 * it, and the action check accepts a write only under the operation it
 * serves. A read is decided exactly like the raw request it is.
 */
export async function handle(
  deps: PipelineDeps,
  req: IncomingShape,
  via?: ViaOperation,
): Promise<ResponseShape> {
  const startedAt = deps.now?.() ?? Date.now();
  const traceId = traceIdOf(req.headers.traceparent);
  const deny = (options: DenialOptions): ResponseShape =>
    denialResponse(deps.provider, options);
  const provenance = {
    ...(traceId === undefined ? {} : { traceId }),
    ...(via === undefined ? {} : { viaOperation: via.operation }),
  };
  // What the catalog and NARROW decide on: the request, and where it came
  // from. Built once, so the two cannot be asked about different origins.
  const decided: CatalogRequest = {
    method: req.method,
    path: req.path,
    body: req.body,
    ...(via === undefined ? {} : { via }),
  };
  try {
    const { claims, expired } = verified(deps, bearerToken(req.headers));
    const anonymous: RequestContext = {
      missionId: expired?.id ?? "unknown",
      startedAt,
      ...provenance,
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
      ...provenance,
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

    // INTROSPECTION answers here, after the token is known live and BEFORE the
    // connection check: the mission that most needs to ask what it is, is the
    // one this listener is not in (`introspect.ts`).
    if (isIntrospection(req)) {
      emitEvent(deps, ctx, INTROSPECTION_VERDICT);
      return introspectionResponse(
        claims,
        startedAt,
        deps.operations.catalogue,
      );
    }

    // OPERATIONS answer here too, before the connection check, for the same
    // reason: the route is missura's, and the inner calls it plans re-enter
    // this very function on the connector they belong to (`operations.ts`).
    const operation = operationName(req);
    if (operation !== undefined) {
      return await executeOperation(deps, req, ctx, claims, operation, handle);
    }

    // The mission decides which connections it may touch. Separate ports are a
    // convenience, not a boundary: a token minted for one connection must not
    // work against another listener just because the agent aimed at its port.
    if (!claims.connections.includes(deps.provider)) {
      emitEvent(deps, ctx, claimsDenial(UNKNOWN_VERDICT, CONNECTION_REASON));
      return deny(connectionDenial(mission));
    }

    const verdict = deps.decide(decided);
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
    // this agent may do with it. An ALLOW the mission does not cover is a
    // deny. A read is covered by the verb; a write only by the operation this
    // call serves, when its effect is the verdict's and its name is granted.
    const servedBy =
      via === undefined
        ? undefined
        : deps.operations.catalogue.find((op) => op.name === via.operation);
    if (!actionCovered(claims, verdict.action, servedBy)) {
      emitEvent(deps, ctx, claimsDenial(verdict, ACTION_REASON));
      return deny(actionDenial(mission, verdict.action));
    }

    // NARROW runs last, on an already-cataloged request: it shrinks what the
    // agent asked for to what the mission proves it may see. For a write it
    // is the only check there is — a comment cannot be filtered after it
    // was posted — and it runs here, before the vendor is reached.
    const narrowed = deps.narrow(decided, claims);
    if (narrowed.decision === "deny") {
      const reason = narrowed.reason ?? "narrowed out of mission scope";
      emitEvent(deps, ctx, claimsDenial(verdict, reason), reason);
      return deny({ ...scopeDenial(narrowed, reason), ...mission });
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
    const target = upstreamTarget(deps, outbound.req.path);
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

    // PARENT PROOF: a child whose own response names no owner is served only
    // once its parent is proven to belong to the mission (`parent-proof.ts`).
    // Placed after the cursor and origin checks so a request already refused
    // never spends a vendor call, and every way of failing — foreign owner,
    // missing owner, absent parent, broken probe — lands on the SAME refusal
    // the NARROW stage builds above.
    const unproven = await parentProofStage(deps, {
      narrowed,
      req: outbound.req,
      verdict,
      ctx,
      claims,
    });
    if (unproven !== undefined) return deny({ ...unproven, ...mission });

    // FILTER runs last, on the vendor's answer: the request was allowed to run,
    // and what comes back is cut down to what the mission proves it may see.
    // REFILL then repairs the page filtering made short — bounded, and through
    // this same `forward`, so there is one path to the vendor and one audit
    // record per call.
    const filter = filterTask(narrowed);
    const answer = await forward(
      deps,
      target,
      outbound.req,
      verdict,
      ctx,
      filter,
      claims,
    );
    const merged = await refill(
      deps,
      {
        req: outbound.req,
        verdict,
        ctx,
        filter,
        claims,
        ...(outbound.resume === undefined ? {} : { resume: outbound.resume }),
      },
      answer,
    );
    // On every response the rule describes: the vendor's position is replaced
    // by a handle. Doing it only on a walked answer would make the cursor's
    // own format say that a walk happened. `merged.served` rides along INSIDE
    // the handle — objects the walk collected but had no room for, owed to
    // the next page rather than dropped.
    const sealed = withMissuraCursor(
      merged,
      narrowed.filterPlan,
      claims.id,
      deps.cursors,
      merged.served,
    );
    // Last: a view the filter or the walk cut down says so — as one boolean,
    // never as a number (`reduced.ts`).
    return markReduced(deps.provider, sealed, merged.reduced);
  } catch {
    // Never echo the internal error: it may quote the request or the vendor.
    return deny({
      status: 500,
      code: "missura_internal",
      reason: "missura failed while deciding this request",
    });
  }
}
