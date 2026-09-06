import {
  approvalDecisionEvent,
  type ApprovalRecord,
  type ApprovalView,
  type DecisionEvent,
  type MissionStore,
} from "@missura/core";
import { FieldError } from "./operator-request";

/**
 * THE OPERATOR'S SIDE OF AN APPROVAL (M10): `GET /v1/approvals` lists what
 * is pending — with the planned call, the operator may see everything — and
 * `POST /v1/approvals/<id>` `{decision, actor}` records a decision.
 *
 * Recording is all this plane does. It holds the operator key and nothing
 * that reaches a vendor — no credential, no pipeline, no fetch — so an
 * approval cannot run here even by mistake. It runs when the agent comes
 * back for it, on the data plane, under its own token.
 */
export const APPROVALS_PATH = "/v1/approvals";

/** The id under `/v1/approvals/<id>`, or `undefined` for any other path. */
export function approvalIdOf(path: string): string | undefined {
  if (!path.startsWith(`${APPROVALS_PATH}/`)) return undefined;
  const id = path.slice(APPROVALS_PATH.length + 1);
  return id.length === 0 || id.includes("/") ? undefined : id;
}

export function listApprovals(store: MissionStore): { approvals: ApprovalView[] } {
  return { approvals: store.pendingApprovals() };
}

function readDecision(value: unknown): "approved" | "denied" {
  if (value === "approved" || value === "denied") return value;
  throw new FieldError("decision", 'decision must be "approved" or "denied"');
}

function readActor(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FieldError("actor", "actor must be a non-empty string: who is deciding");
  }
  return value.trim();
}

/**
 * The fields first, then the store: an unknown id, a decided approval and a
 * dead mission are all the id's fault, in the store's own words. Recorded,
 * then LOGGED (M4): the decision is a line of the decision log, and a log
 * that cannot be written fails the decision — never the other way round.
 */
export function decideApproval(
  deps: { store: MissionStore; emit(ev: DecisionEvent): void },
  id: string,
  body: Record<string, unknown>,
): { approval: ApprovalRecord } {
  const decision = readDecision(body.decision);
  const actor = readActor(body.actor);
  let approval: ApprovalRecord;
  try {
    approval = deps.store.decideApproval(id, decision, actor);
  } catch (err) {
    throw new FieldError("id", err instanceof Error ? err.message : "approval cannot be decided");
  }
  deps.emit(approvalDecisionEvent(approval, Date.now()));
  return { approval };
}
