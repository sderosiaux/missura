import type { CatalogDecision, DecisionEvent, Provider } from "@missura/core";

/**
 * What writing an audit record needs, and nothing else: which connector spoke,
 * where the record goes, and what time it is.
 */
export interface AuditDeps {
  provider: Provider;
  emit(ev: DecisionEvent): void;
  now?(): number;
}

/**
 * Everything the audit record knows about the request that is not the verdict:
 * who (`actor`), what for (`purpose`) and the caller's trace, filled in as
 * soon as the claims are verified.
 */
export interface RequestContext {
  missionId: string;
  startedAt: number;
  actor?: string;
  purpose?: string;
  traceId?: string;
}

/** No token, or one whose signature this proxy cannot verify. */
export const UNAUTHENTICATED_REASON = "authn: missing or invalid mission token";
/**
 * Signature valid, clock past `exp`. Kept apart from the line above because it
 * is the one authn failure that still describes a real mission, and the agent
 * gets told which — its own.
 */
export const EXPIRED_REASON = "mission expired";
/** Reasons a verified token still does not get through. */
export const REVOKED_REASON = "revoked";
export const CONNECTION_REASON = "connection not in mission";
export const ACTION_REASON = "action not allowed by mission";
/** Every request target that would leave the connector's origin. */
export const ESCAPE_REASON = "path escapes upstream origin";
/** The vendor answered, but the answer was refused. */
export const TOO_LARGE_REASON = "response too large (after upstream call)";

export const UNKNOWN_VERDICT: CatalogDecision = {
  decision: "deny",
  operation: "unknown",
  action: "unknown",
  reason: "unknown",
};

/**
 * The audit record is part of the answer, not a side effect: if it cannot be
 * written the request fails closed (500) rather than serving an unlogged
 * decision. Callers therefore let `emit` throw.
 */
export function emitEvent(
  deps: AuditDeps,
  ctx: RequestContext,
  decision: CatalogDecision,
  reason?: string,
  objectsRemoved?: number,
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
    ...(objectsRemoved === undefined ? {} : { objectsRemoved }),
  });
}

/** A claims denial keeps the catalog's operation/action so the log stays readable. */
export function claimsDenial(
  verdict: CatalogDecision,
  reason: string,
): CatalogDecision {
  return { ...verdict, decision: "deny", reason };
}
