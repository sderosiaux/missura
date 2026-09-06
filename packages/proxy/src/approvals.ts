import {
  approvalState,
  type CatalogDecision,
  type MissionClaims,
  type MissionStore,
} from "@missura/core";
import { claimsDenial, emitEvent, type RequestContext } from "./audit";
import { denialResponse } from "./deny";
import type { PipelineDeps } from "./pipeline";
import { JSON_HEADERS, type IncomingShape, type ResponseShape } from "./transport";

/**
 * THE AGENT'S SIDE OF AN APPROVAL (M10): `GET /missura/approvals/<id>`,
 * bearer = the mission token, on any listener like introspection and for
 * the same reasons (`introspect.ts`). It answers the state of an approval
 * that belongs to THIS mission — `pending`, `approved`, `denied`, or
 * `consumed` once it ran — and the listener's own not-found for anything
 * else. Another mission's id and an id that never existed are the same
 * bytes: an approval is this mission's or it is nothing.
 *
 * What the store must offer the data plane, and no more: open, read back,
 * spend. Deciding is the operator plane's, and this type cannot reach it.
 */
export type ApprovalStore = Pick<
  MissionStore,
  "requestApproval" | "approvalFor" | "consumeApproval"
>;

/**
 * The store of a proxy that serves no operations, and of the specs that
 * install none: records nothing, finds nothing, and a gated write that
 * somehow reached it would fail closed rather than run.
 */
export const NO_APPROVALS: ApprovalStore = {
  requestApproval: (): never => {
    throw new Error("this proxy records no approvals");
  },
  approvalFor: (): undefined => undefined,
  consumeApproval: (): never => {
    throw new Error("this proxy records no approvals");
  },
};

export const APPROVAL_ROUTE = "/missura/approvals/";

/** Only the poll: a method other than GET on this route is a vendor request. */
export function approvalIdOf(req: IncomingShape): string | undefined {
  if (req.method.toUpperCase() !== "GET") return undefined;
  const path = req.path.split("?")[0] ?? "";
  if (!path.startsWith(APPROVAL_ROUTE)) return undefined;
  const id = path.slice(APPROVAL_ROUTE.length);
  return id.length === 0 || id.includes("/") ? undefined : id;
}

const POLL_VERDICT: CatalogDecision = {
  decision: "allow",
  operation: "missura.approval",
  action: "introspect",
  reason: "approval state",
};

export const APPROVAL_UNKNOWN_REASON = "no approval by that id on this mission";

/** The listener's own not-found, naming nothing: not the id, not whose it is. */
export function approvalUnknown(
  deps: PipelineDeps,
  ctx: RequestContext,
  claims: MissionClaims,
  verdict: CatalogDecision,
): ResponseShape {
  emitEvent(deps, ctx, claimsDenial(verdict, APPROVAL_UNKNOWN_REASON));
  return denialResponse(deps.provider, {
    status: 404,
    code: "missura_approval_unknown",
    reason: APPROVAL_UNKNOWN_REASON,
    claims,
    now: ctx.startedAt,
  });
}

export function pollApproval(
  deps: PipelineDeps,
  ctx: RequestContext,
  claims: MissionClaims,
  id: string,
): ResponseShape {
  const approval = deps.operations.approvals.approvalFor(claims.id, id, ctx.startedAt);
  if (approval === undefined) return approvalUnknown(deps, ctx, claims, POLL_VERDICT);
  emitEvent(deps, { ...ctx, approvalId: id }, POLL_VERDICT);
  return {
    status: 200,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ id, state: approvalState(approval) }),
  };
}
