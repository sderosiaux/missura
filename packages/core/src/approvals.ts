import type { OperationStep } from "./operation";

/**
 * AN APPROVAL (M10): the record a `destroy` or `egress` operation leaves on
 * its mission instead of running. A proxy is request/response and has nowhere
 * to park a wait, so the wait is the agent's: it asks, a human decides on the
 * operator plane, it asks again. This file is the record and the rules on it;
 * the store (`missions.ts`) keeps it beside the mission, in the one state
 * file, so the mission's own TTL bounds every approval and a revoke ends
 * both at once.
 *
 * Deciding writes `decision`; it never runs anything. Execution happens on
 * the data plane, on the agent's re-request, under the agent's own token —
 * the operator plane approving is not the operator plane acting.
 */

export type ApprovalDecision = "approved" | "denied";

/** Derived, never stored: the record's fields say which. */
export type ApprovalState = "pending" | ApprovalDecision | "consumed";

/** What the agent asked for, and the exact inner call(s) that would go. */
export interface ApprovalRequest {
  operation: string;
  params: Readonly<Record<string, unknown>>;
  planned: readonly OperationStep[];
}

export interface ApprovalRecord extends ApprovalRequest {
  id: string;
  missionId: string;
  /** Epoch seconds, like the mission's own stamps. */
  requestedAt: number;
  decision?: { decision: ApprovalDecision; actor: string; at: number };
  /**
   * Set when the approved call left for the vendor — before it did, so a
   * second request racing the first finds it consumed. At most once.
   */
  consumedAt?: number;
}

export function approvalState(record: ApprovalRecord): ApprovalState {
  if (record.consumedAt !== undefined) return "consumed";
  return record.decision?.decision ?? "pending";
}

/**
 * How far along a record is. Records only ever move forward — pending,
 * decided, consumed — so two copies of one approval are ordered by this, and
 * the later one is the truth whatever file it came from.
 */
function progress(record: ApprovalRecord): number {
  if (record.consumedAt !== undefined) return 2;
  return record.decision === undefined ? 0 : 1;
}

/**
 * Two views of the same approvals, merged so no record moves backwards. A
 * process that still held "approved" in memory must not rewrite over another
 * process's "consumed": that is the one merge that would run a write twice.
 * File order first, then what only we hold.
 */
export function mergeApprovals(
  disk: readonly ApprovalRecord[],
  ours: readonly ApprovalRecord[],
): ApprovalRecord[] {
  const byId = new Map<string, ApprovalRecord>();
  for (const record of disk) byId.set(record.id, record);
  for (const record of ours) {
    const held = byId.get(record.id);
    if (held === undefined || progress(record) >= progress(held)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStep(value: unknown): value is OperationStep {
  return (
    isRecord(value) &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    typeof value.body === "string"
  );
}

function isDecision(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.decision === "approved" || value.decision === "denied") &&
    typeof value.actor === "string" &&
    typeof value.at === "number"
  );
}

/** Absent is a file written before approvals existed; malformed fails closed. */
export function parseApprovals(value: unknown): ApprovalRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("mission state file is malformed: approvals");
  return value.map((entry: unknown): ApprovalRecord => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.missionId !== "string" ||
      typeof entry.operation !== "string" ||
      typeof entry.requestedAt !== "number" ||
      !isRecord(entry.params) ||
      !Array.isArray(entry.planned) ||
      !entry.planned.every(isStep) ||
      (entry.decision !== undefined && !isDecision(entry.decision)) ||
      (entry.consumedAt !== undefined && typeof entry.consumedAt !== "number")
    ) {
      throw new Error("mission state file is malformed: approval entry");
    }
    return entry as unknown as ApprovalRecord;
  });
}
