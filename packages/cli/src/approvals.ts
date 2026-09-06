import type { ApprovalDecision, ApprovalRecord } from "@missura/core";
import type { CliIo } from "./io";
import { formatTtl, openStore } from "./missions";
import { resolveHome } from "./paths";

/**
 * `missura approvals` / `approve <id>` / `deny <id>` — the operator's side
 * of an approval (M10), on the same state file `missura run` records them
 * in, so a decision typed here lands on the proxy's very next request.
 *
 * Listing shows the planned call in full. This is the operator's terminal:
 * unlike everything an agent is answered, nothing here is redacted.
 * Deciding writes a name and a time; nothing in this process can run the
 * call, and that is the point of the design — the run is the agent's, on
 * the data plane, under its own token.
 */

const HEADERS = ["ID", "MISSION", "OPERATION", "CALL", "AGE"];

/** The one planned call, or the count when a plan has several. */
function callOf(approval: ApprovalRecord): string {
  const [first, ...rest] = approval.planned;
  if (first === undefined) return "(nothing planned)";
  const call = `${first.method} ${first.path}`;
  return rest.length === 0 ? call : `${call} (+${String(rest.length)} more)`;
}

function row(approval: ApprovalRecord, nowSeconds: number): string[] {
  return [
    approval.id,
    approval.missionId,
    approval.operation,
    callOf(approval),
    formatTtl(nowSeconds - approval.requestedAt),
  ];
}

function table(rows: string[][]): string[] {
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((r) => (r[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(HEADERS), ...rows.map(line)];
}

export function approvalsCommand(io: CliIo, json: boolean): number {
  const pending = openStore(resolveHome(io.env)).pendingApprovals();
  if (json) {
    io.stdout(JSON.stringify({ approvals: pending }));
    return 0;
  }
  if (pending.length === 0) {
    io.stdout("no pending approvals");
    return 0;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const line of table(pending.map((a) => row(a, nowSeconds)))) io.stdout(line);
  return 0;
}

/**
 * A human typing an id wants to know when they typed it wrong: unknown,
 * already decided and dead-mission approvals all fail loudly, in the
 * store's own words.
 */
export function decideCommand(
  io: CliIo,
  decision: ApprovalDecision,
  id: string | undefined,
  actor: string,
): number {
  if (id === undefined || id.trim() === "") {
    throw new Error(
      `missura ${decision === "approved" ? "approve" : "deny"} needs an approval id (see: missura approvals)`,
    );
  }
  const record = openStore(resolveHome(io.env)).decideApproval(id.trim(), decision, actor);
  io.stdout(`${decision} ${record.id} (by ${actor})`);
  return 0;
}
