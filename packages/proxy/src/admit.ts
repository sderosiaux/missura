import {
  actionCovered,
  type CatalogDecision,
  type CatalogRequest,
  type MissionClaims,
} from "@missura/core";
import {
  ACTION_REASON,
  claimsDenial,
  CONNECTION_REASON,
  emitEvent,
  UNKNOWN_VERDICT,
  type RequestContext,
} from "./audit";
import { actionDenial, connectionDenial, denialResponse } from "./deny";
import { scopeDenial, type NarrowResult } from "./narrow";
import type { PipelineDeps } from "./pipeline";
import type { ResponseShape } from "./transport";

/**
 * ADMISSION: the request-side decision, in one place — connection, catalog,
 * action, NARROW — with every refusal it can produce. `handle` runs it on
 * the way to the vendor; the operation executor runs it on its own to PROVE
 * a write it is about to write down for a human (M10), so that a foreign
 * target is refused, with the same bytes and the same audit record, before
 * an approval exists — and without a second copy of these four checks.
 *
 * Nothing here reaches a vendor, spends a cursor or records a proof: it is
 * the part of the pipeline that can be asked twice without cost.
 */
export interface Admission {
  verdict: CatalogDecision;
  narrowed: NarrowResult;
}

export function admit(
  deps: PipelineDeps,
  req: CatalogRequest,
  claims: MissionClaims,
  ctx: RequestContext,
  now: number,
): Admission | { refusal: ResponseShape } {
  const mission = { claims, now };
  const refuse = (response: ResponseShape): { refusal: ResponseShape } => ({ refusal: response });

  // The mission decides which connections it may touch. Separate ports are a
  // convenience, not a boundary: a token minted for one connection must not
  // work against another listener just because the agent aimed at its port.
  if (!claims.connections.includes(deps.provider)) {
    emitEvent(deps, ctx, claimsDenial(UNKNOWN_VERDICT, CONNECTION_REASON));
    return refuse(denialResponse(deps.provider, connectionDenial(mission)));
  }

  const verdict = deps.decide(req);
  if (verdict.decision === "deny") {
    emitEvent(deps, ctx, verdict);
    return refuse(
      denialResponse(deps.provider, {
        status: 403,
        code: "missura_operation_not_in_catalog",
        reason: verdict.reason,
        ...mission,
      }),
    );
  }

  // The catalog says what the connector can serve; the mission says what
  // this agent may do with it. An ALLOW the mission does not cover is a
  // deny. A read is covered by the verb; a write only by the operation this
  // call serves, when its effect is the verdict's and its name is granted.
  const via = req.via;
  const servedBy =
    via === undefined
      ? undefined
      : deps.operations.catalogue.find((op) => op.name === via.operation);
  if (!actionCovered(claims, verdict.action, servedBy)) {
    emitEvent(deps, ctx, claimsDenial(verdict, ACTION_REASON));
    return refuse(denialResponse(deps.provider, actionDenial(mission, verdict.action)));
  }

  // NARROW runs last, on an already-cataloged request: it shrinks what the
  // agent asked for to what the mission proves it may see. For a write it
  // is the only check there is — a comment cannot be filtered after it
  // was posted — and it runs here, before the vendor is reached.
  const narrowed = deps.narrow(req, claims);
  if (narrowed.decision === "deny") {
    const reason = narrowed.reason ?? "narrowed out of mission scope";
    emitEvent(deps, ctx, claimsDenial(verdict, reason), reason);
    return refuse(denialResponse(deps.provider, { ...scopeDenial(narrowed, reason), ...mission }));
  }
  return { verdict, narrowed };
}
