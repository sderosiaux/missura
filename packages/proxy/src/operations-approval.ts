import {
  approvalState,
  type CatalogDecision,
  type MissionClaims,
  type Operation,
  type OperationStep,
} from "@missura/core";
import { approvalUnknown } from "./approvals";
import { claimsDenial, emitEvent, type RequestContext } from "./audit";
import { denialResponse } from "./deny";
import type { PipelineDeps } from "./pipeline";
import { JSON_HEADERS, type ResponseShape } from "./transport";

/**
 * THE GATE (M10): a `destroy` or an `egress` does not run on request. The
 * executor proves it first, exactly as it proves an append (`admit` on the
 * target's own pipeline), then instead of running it writes it down on the
 * mission as the exact inner call that would go and answers `202`. The agent
 * comes back with `approval: <id>` once a human has decided; the executor
 * checks it is THIS mission's, for THIS operation with THESE parameters and
 * THIS plan, `approved` and not yet spent — spends it, then runs.
 *
 * Why the agent re-requests instead of the approval running on approve:
 * execution has to stay on the data plane, under the agent's own token,
 * through the same enforcement every other call gets. The operator plane
 * approving is a record; the operator plane acting would be a second path to
 * the vendor, holding the operator key. There is no such path.
 */
export const APPROVAL_REQUIRED_REASON = "approval required";
const REFUSED_CODE = "missura_approval_refused";

/** The two effects a human must approve: irreversible, or leaving the boundary. */
export function requiresApproval(op: Operation): boolean {
  return op.effect === "destroy" || op.effect === "egress";
}

/**
 * `approval` is reserved on the body of a gated operation: the id, or
 * nothing. Anything else is the agent's own parameter shape to fix.
 */
export function splitApproval(
  raw: Readonly<Record<string, unknown>>,
): { params: Readonly<Record<string, unknown>>; approval?: string } | { invalid: string } {
  const { approval, ...params } = raw;
  if (approval === undefined) return { params };
  if (typeof approval !== "string" || approval.length === 0) {
    return { invalid: "parameter `approval` must be an approval id, as the `202` answer gave it" };
  }
  return { params, approval };
}

/** Key order is not a difference: the same parameters spelled twice are the same. */
function canonical(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sorted(entry)]),
  );
}

export interface Gated {
  deps: PipelineDeps;
  ctx: RequestContext;
  claims: MissionClaims;
  op: Operation;
  params: Readonly<Record<string, unknown>>;
  steps: readonly OperationStep[];
  verdict: CatalogDecision;
}

/** Writes the approval down and answers `202`: the id and its state, nothing else. */
export function openApproval(gate: Gated): ResponseShape {
  const { deps, ctx, claims, op, params, steps, verdict } = gate;
  const approval = deps.operations.approvals.requestApproval(
    claims.id,
    { operation: op.name, params, planned: steps },
    ctx.startedAt,
  );
  emitEvent(
    deps,
    { ...ctx, approvalId: approval.id },
    { ...verdict, decision: "pending", reason: APPROVAL_REQUIRED_REASON },
  );
  return {
    status: 202,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ id: approval.id, state: "pending" }),
  };
}

/**
 * Spends the approval for this very request, or refuses without a vendor
 * call. The mismatch refusals say what mismatched — the agent's own request
 * against its own approval, nothing about a target — and spend nothing:
 * the approval stays usable for the request it was opened for.
 */
export function spendApproval(gate: Gated, id: string): { id: string } | { refusal: ResponseShape } {
  const { deps, ctx, claims, op, params, steps, verdict } = gate;
  const refuse = (reason: string): { refusal: ResponseShape } => {
    emitEvent(deps, { ...ctx, approvalId: id }, claimsDenial(verdict, reason));
    return {
      refusal: denialResponse(deps.provider, {
        status: 403,
        code: REFUSED_CODE,
        reason,
        claims,
        now: ctx.startedAt,
      }),
    };
  };
  const approval = deps.operations.approvals.approvalFor(claims.id, id, ctx.startedAt);
  if (approval === undefined) {
    return { refusal: approvalUnknown(deps, ctx, claims, verdict) };
  }
  if (
    approval.operation !== op.name ||
    canonical(approval.params) !== canonical(params) ||
    canonical(approval.planned) !== canonical(steps)
  ) {
    return refuse("approval was opened for a different operation or parameters");
  }
  const state = approvalState(approval);
  if (state !== "approved") return refuse(`approval is ${state}`);
  // Spent BEFORE the call leaves: a request racing this one finds it consumed.
  try {
    deps.operations.approvals.consumeApproval(id, ctx.startedAt);
  } catch {
    return refuse("approval is consumed");
  }
  return { id };
}
