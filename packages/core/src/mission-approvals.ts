import { randomBytes } from "node:crypto";
import { openApproval, purgedApproval, sealRequest } from "./approval-seal";
import {
  ApprovalRefusedError,
  approvalState,
  approvalTarget,
  MAX_PENDING_APPROVALS_PER_MISSION,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApprovalView,
} from "./approvals";
import type { MissionRecord } from "./mission-record";

/**
 * The approval ledger's rules, as functions over the store's arrays: what
 * gets written down (H1: one per target, few per mission, none too large —
 * M3: sealed), and what gets purged (M3: every body nobody has to read).
 * `MissionStore` owns the arrays and the file; this owns the rules.
 */

/**
 * A new pending record on `missionId`, or the refusal. Dedup first, by
 * target: the second request on a target a human has not decided yet is
 * refused naming the first, so the human reads one row per target and the
 * agent cannot get one wording approved and replay another. Then the cap.
 * Then the size, inside `sealRequest`.
 */
export function newApproval(
  key: Buffer,
  approvals: readonly ApprovalRecord[],
  missionId: string,
  request: ApprovalRequest,
  now: number,
): ApprovalRecord {
  const pending = approvals.filter(
    (a) => a.missionId === missionId && approvalState(a) === "pending",
  );
  const target = approvalTarget(request.operation, request.planned);
  const twin = pending.find(
    (a) => approvalTarget(a.operation, openApproval(key, a).planned) === target,
  );
  if (twin !== undefined) {
    throw new ApprovalRefusedError(
      "duplicate",
      `an approval for this operation and target is already pending: ${twin.id}`,
    );
  }
  if (pending.length >= MAX_PENDING_APPROVALS_PER_MISSION) {
    throw new ApprovalRefusedError(
      "limit",
      `this mission already holds ${String(MAX_PENDING_APPROVALS_PER_MISSION)} pending approvals`,
    );
  }
  return {
    id: `apr_${randomBytes(8).toString("hex")}`,
    missionId,
    operation: request.operation,
    requestedAt: Math.floor(now / 1000),
    ...sealRequest(key, request),
  };
}

/** Pending, on live missions, opened for the human who has to read them. */
export function pendingViews(
  key: Buffer,
  approvals: readonly ApprovalRecord[],
  liveMissionIds: ReadonlySet<string>,
): ApprovalView[] {
  return approvals
    .filter((a) => approvalState(a) === "pending" && liveMissionIds.has(a.missionId))
    .map((a) => openApproval(key, a));
}

/**
 * Every record whose body nobody will read again, purged: denied, consumed,
 * and every one on a mission that is expired, revoked or gone. Returns the
 * new array and whether it differs — a caller persists only when it does.
 */
export function purgeUnreadable(
  approvals: readonly ApprovalRecord[],
  missions: readonly MissionRecord[],
  revokedJtis: ReadonlySet<string>,
  now: number,
): { approvals: ApprovalRecord[]; purged: boolean } {
  const seconds = Math.floor(now / 1000);
  const live = new Set(
    missions
      .filter(
        (m) => m.revokedAt === undefined && !revokedJtis.has(m.jti) && m.expiresAt > seconds,
      )
      .map((m) => m.id),
  );
  let purged = false;
  const out = approvals.map((a) => {
    if (a.sealed === undefined) return a;
    const state = approvalState(a);
    const readable = (state === "pending" || state === "approved") && live.has(a.missionId);
    if (readable) return a;
    purged = true;
    return purgedApproval(a);
  });
  return { approvals: out, purged };
}
