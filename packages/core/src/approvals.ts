import { createHash } from "node:crypto";
import type { OperationStep } from "./operation";
import { isSealedText, type SealedText } from "./seal";

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
 *
 * WHAT IS ON DISK (M3). The request — the parameters and the exact calls,
 * hence the reply text a customer will receive — is SEALED under the vault
 * key while a human still has to read it, and purged the moment nobody does:
 * denied, consumed, expired, revoked. What outlives a decision is what an
 * audit needs: ids, operation, actor, timestamps, and the hash a re-POST is
 * matched against. The state file holds no body in the clear, ever.
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

export interface ApprovalRecord {
  id: string;
  missionId: string;
  operation: string;
  /** Epoch seconds, like the mission's own stamps. */
  requestedAt: number;
  /**
   * `hashApprovalRequest` of what was asked: the one thing a re-request is
   * matched against, and the one thing about the request that outlives it.
   */
  requestHash: string;
  /**
   * The request itself — `params` and `planned`, as one JSON text — sealed
   * under the vault key. Present while pending or approved-and-unspent;
   * absent once purged.
   */
  sealed?: SealedText;
  decision?: { decision: ApprovalDecision; actor: string; at: number };
  /**
   * Set when the approved call left for the vendor — before it did, so a
   * second request racing the first finds it consumed. At most once.
   */
  consumedAt?: number;
}

/** A record with its request opened: what an operator reads. Never on disk. */
export type ApprovalView = Omit<ApprovalRecord, "sealed"> & ApprovalRequest;

export function approvalState(record: ApprovalRecord): ApprovalState {
  if (record.consumedAt !== undefined) return "consumed";
  return record.decision?.decision ?? "pending";
}

/**
 * How many approvals one mission may have waiting at once. Small on purpose:
 * a human reads every one of them, and an agent that could queue hundreds
 * would be writing hundreds of bodies into the state file on one token.
 */
export const MAX_PENDING_APPROVALS_PER_MISSION = 5;

/**
 * How large one approval's request may be — parameters and planned calls
 * together, as the JSON that is sealed. A reply is text a human will read
 * in a terminal, not a blob; the listener's 10 MiB request cap is for vendor
 * documents, and it must not be the cap on what one token can write to disk.
 */
export const MAX_APPROVAL_BYTES = 32 * 1024;

/**
 * A request the store will not write down: the target already has a pending
 * approval, the mission is at its cap, or the request is too large. The
 * executor answers it as a refusal, in the message's own words — nothing
 * here names a vendor object the agent did not name itself.
 */
export class ApprovalRefusedError extends Error {
  readonly kind: "duplicate" | "limit" | "too_large";
  constructor(kind: "duplicate" | "limit" | "too_large", message: string) {
    super(message);
    this.name = "ApprovalRefusedError";
    this.kind = kind;
  }
}

/**
 * What an approval is ABOUT, body aside: the operation and the exact vendor
 * calls it would make. Two requests with the same targets and two bodies are
 * one row to the human reading them, so they are one approval here — the
 * second is refused by name rather than written beside the first, where an
 * agent could get one approved and replay the other.
 */
export function approvalTarget(operation: string, planned: readonly OperationStep[]): string {
  return JSON.stringify([
    operation,
    planned.map((step) => `${step.method.toUpperCase()} ${step.path}`),
  ]);
}

/** Key order is not a difference: the same parameters spelled twice are the same. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sorted(entry)]),
  );
}

/** The canonical request, as one JSON text: what is hashed and what is sealed. */
export function canonicalApprovalRequest(request: ApprovalRequest): string {
  return JSON.stringify(
    sorted({ operation: request.operation, params: request.params, planned: request.planned }),
  );
}

/** sha256 of the canonical request: THIS operation, THESE parameters, THIS plan. */
export function hashApprovalRequest(request: ApprovalRequest): string {
  return createHash("sha256").update(canonicalApprovalRequest(request)).digest("hex");
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
 * File order first, then what only we hold. At equal progress a PURGED copy
 * wins: a body that was taken off the disk stays off it.
 */
export function mergeApprovals(
  disk: readonly ApprovalRecord[],
  ours: readonly ApprovalRecord[],
): ApprovalRecord[] {
  const byId = new Map<string, ApprovalRecord>();
  for (const record of disk) byId.set(record.id, record);
  for (const record of ours) {
    const held = byId.get(record.id);
    if (held === undefined || progress(record) > progress(held)) {
      byId.set(record.id, record);
    } else if (progress(record) === progress(held) && held.sealed !== undefined) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      typeof entry.requestHash !== "string" ||
      (entry.sealed !== undefined && !isSealedText(entry.sealed)) ||
      (entry.decision !== undefined && !isDecision(entry.decision)) ||
      (entry.consumedAt !== undefined && typeof entry.consumedAt !== "number")
    ) {
      throw new Error("mission state file is malformed: approval entry");
    }
    return entry as unknown as ApprovalRecord;
  });
}
