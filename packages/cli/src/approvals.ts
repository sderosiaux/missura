import {
  appendEvent,
  approvalDecisionEvent,
  verifyLog,
  type ApprovalDecision,
  type ApprovalView,
} from "@missura/core";
import type { CliIo } from "./io";
import { formatTtl, openStore } from "./missions";
import { resolveHome } from "./paths";

/**
 * `missura approvals` / `approve <id>` / `deny <id>` — the operator's side
 * of an approval (M10), on the same state file `missura run` records them
 * in, so a decision typed here lands on the proxy's very next request.
 *
 * Listing shows the planned call in full — and its BODY. An egress is a
 * reply the customer will receive by email: a human who approves a `PUT`
 * without the text in front of them has approved nothing. The default table
 * carries every body cut to its column, never dropped; `--full` prints each
 * one whole. This is the operator's terminal: unlike everything an agent is
 * answered, nothing here is redacted.
 *
 * Deciding writes a name and a time — on the record, and as a line of the
 * decision log the proxy writes, chained onto its last line (M4). Nothing
 * in this process can run the call, and that is the point of the design —
 * the run is the agent's, on the data plane, under its own token.
 */

const HEADERS = ["ID", "MISSION", "OPERATION", "CALL", "BODY", "AGE"];

/** Columns past this many characters are cut, with a mark that says so. */
const BODY_COLUMN = 72;
const NO_BODY = "(no body)";

/** The one planned call, or the count when a plan has several. */
function callOf(approval: ApprovalView): string {
  const [first, ...rest] = approval.planned;
  if (first === undefined) return "(nothing planned)";
  const call = `${first.method} ${first.path}`;
  return rest.length === 0 ? call : `${call} (+${String(rest.length)} more)`;
}

/** Every planned body, one line: what will leave, as bytes. */
function bodyOf(approval: ApprovalView): string {
  const bodies = approval.planned.map((step) => step.body).filter((body) => body.length > 0);
  if (bodies.length === 0) return NO_BODY;
  return bodies.join(" | ").replace(/\s+/g, " ");
}

function cut(text: string): string {
  return text.length <= BODY_COLUMN ? text : `${text.slice(0, BODY_COLUMN - 1)}…`;
}

function row(approval: ApprovalView, nowSeconds: number): string[] {
  return [
    approval.id,
    approval.missionId,
    approval.operation,
    callOf(approval),
    cut(bodyOf(approval)),
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

/** One block per approval: the header line, then each call and its whole body. */
function block(approval: ApprovalView, nowSeconds: number): string[] {
  const lines = [
    `${approval.id}  ${approval.missionId}  ${approval.operation}  ${formatTtl(nowSeconds - approval.requestedAt)}`,
  ];
  for (const step of approval.planned) {
    lines.push(`  ${step.method} ${step.path}`);
    lines.push(`  ${step.body.length === 0 ? NO_BODY : step.body}`);
  }
  return lines;
}

export interface ApprovalsOptions {
  json: boolean;
  full: boolean;
}

export function approvalsCommand(io: CliIo, options: ApprovalsOptions): number {
  const pending = openStore(resolveHome(io.env)).pendingApprovals();
  if (options.json) {
    io.stdout(JSON.stringify({ approvals: pending }));
    return 0;
  }
  if (pending.length === 0) {
    io.stdout("no pending approvals");
    return 0;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lines = options.full
    ? pending.flatMap((a) => block(a, nowSeconds))
    : table(pending.map((a) => row(a, nowSeconds)));
  for (const line of lines) io.stdout(line);
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
  const paths = resolveHome(io.env);
  const record = openStore(paths).decideApproval(id.trim(), decision, actor);
  appendEvent(paths.eventsDir, approvalDecisionEvent(record, Date.now()));
  io.stdout(`${decision} ${record.id} (by ${actor})`);
  return 0;
}

/**
 * `missura verify-log`: walks the whole decision log and reports the first
 * break of its hash chain — file and line — or that it is intact, and how
 * long it is. Exit 1 on a break: a log that does not verify is a finding.
 */
export function verifyLogCommand(io: CliIo): number {
  const dir = resolveHome(io.env).eventsDir;
  const verdict = verifyLog(dir);
  if (verdict.ok) {
    io.stdout(
      `chain intact: ${String(verdict.events)} events across ${String(verdict.files)} files in ${dir}`,
    );
    return 0;
  }
  io.stderr(`chain broken at ${verdict.file}:${String(verdict.line)}: ${verdict.reason}`);
  return 1;
}
