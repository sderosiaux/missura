import {
  ApprovalRefusedError,
  canonicalApprovalRequest,
  hashApprovalRequest,
  MAX_APPROVAL_BYTES,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApprovalView,
} from "./approvals";
import type { OperationStep } from "./operation";
import { seal, unseal } from "./seal";

/**
 * The approval request on its way to disk and back (M3): sealed under the
 * vault key, opened for whoever holds it, purged when nobody needs it.
 */

/** The request as it goes on the record: its hash, and its sealed text. */
export function sealRequest(
  key: Buffer,
  request: ApprovalRequest,
): Pick<ApprovalRecord, "requestHash" | "sealed"> {
  // Hashed and sealed: the parameters and the plan. The connector and the
  // effect ride on the record in the clear — they name the operation, not
  // its content, and the decision log needs them after the purge.
  const text = canonicalApprovalRequest(request);
  if (Buffer.byteLength(text, "utf8") > MAX_APPROVAL_BYTES) {
    throw new ApprovalRefusedError(
      "too_large",
      `the approval request is too large: over ${String(MAX_APPROVAL_BYTES)} bytes of parameters and planned calls`,
    );
  }
  return { requestHash: hashApprovalRequest(request), sealed: seal(key, text) };
}

function isStep(value: unknown): value is OperationStep {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OperationStep).method === "string" &&
    typeof (value as OperationStep).path === "string" &&
    typeof (value as OperationStep).body === "string"
  );
}

/**
 * The record with its request opened. Throws on a record already purged —
 * a caller listing pending approvals never meets one, and a caller that
 * does has a bug, not a body to show — and on a wrong key or a tampered
 * text, which the primitive refuses.
 */
export function openApproval(key: Buffer, record: ApprovalRecord): ApprovalView {
  if (record.sealed === undefined) {
    throw new Error(`approval ${record.id} holds no request any more`);
  }
  const parsed: unknown = JSON.parse(unseal(key, record.sealed));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ApprovalRequest).params !== "object" ||
    !Array.isArray((parsed as ApprovalRequest).planned) ||
    !(parsed as ApprovalRequest).planned.every(isStep)
  ) {
    throw new Error(`approval ${record.id} holds a malformed request`);
  }
  const { params, planned } = parsed as ApprovalRequest;
  return { ...purgedApproval(record), params, planned };
}

/** The record without its request: what outlives a decision. */
export function purgedApproval(record: ApprovalRecord): ApprovalRecord {
  const rest: ApprovalRecord = { ...record };
  delete rest.sealed;
  return rest;
}
