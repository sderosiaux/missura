import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "./approvals";
import { appendEvent, approvalDecisionEvent, type DecisionEvent } from "./events";
import { LOG_GENESIS, verifyLog } from "./events-chain";

/**
 * THE HASH CHAIN (M4). Every line of the decision log names the sha256 of
 * the line before it — the first names a fixed genesis — and the writer is
 * the only writer: `appendEvent` reads the log's last line back before it
 * appends, so the chain survives a restart and a second process alike.
 * `verifyLog` walks the files in order and reports the first break.
 */

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "missura-chain-"));
}

const EVENT: DecisionEvent = {
  ts: "2026-08-14T10:00:00.000Z",
  provider: "github",
  operation: "missura.op",
  action: "destroy",
  decision: "pending",
  reason: "approval required",
  missionId: "msn_dev",
  latencyMs: 3,
  approvalId: "apr_0123456789abcdef",
};

const RECORD: ApprovalRecord = {
  id: "apr_0123456789abcdef",
  missionId: "msn_dev",
  operation: "github.issue.comment.delete",
  connector: "github",
  effect: "destroy",
  requestedAt: 1_700_000_000,
  requestHash: "ab".repeat(32),
  decision: { decision: "approved", actor: "ops@acme.io", at: 1_700_000_060 },
};

function lines(dir: string, file: string): string[] {
  return readFileSync(join(dir, file), "utf8").trimEnd().split("\n");
}

function sha256(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

describe("decision log — the chain", () => {
  it("chains pending → approved → allow, each line naming the previous one's hash", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    appendEvent(dir, approvalDecisionEvent(RECORD, 1_700_000_060_000));
    appendEvent(dir, { ...EVENT, decision: "allow", reason: "operation executed" });

    const [first, second, third] = lines(dir, "2026-08-14.jsonl");
    expect((JSON.parse(first ?? "") as { prev: string }).prev).toBe(LOG_GENESIS);
    expect((JSON.parse(second ?? "") as { prev: string }).prev).toBe(sha256(first ?? ""));
    expect((JSON.parse(third ?? "") as { prev: string }).prev).toBe(sha256(second ?? ""));
    expect(verifyLog(dir)).toEqual({ ok: true, events: 3, files: 1 });
  });

  it("detects a tampered middle line, naming the file and the line", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    appendEvent(dir, { ...EVENT, decision: "deny", reason: "revoked" });
    appendEvent(dir, { ...EVENT, decision: "allow" });
    const path = join(dir, "2026-08-14.jsonl");
    const tampered = lines(dir, "2026-08-14.jsonl");
    tampered[1] = (tampered[1] ?? "").replace('"deny"', '"allow"');
    writeFileSync(path, `${tampered.join("\n")}\n`);

    expect(verifyLog(dir)).toEqual({
      ok: false,
      file: "2026-08-14.jsonl",
      line: 3,
      reason: expect.stringContaining("prev") as string,
    });
  });

  it("detects a removed line and a line appended without a prev", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    appendEvent(dir, { ...EVENT, decision: "deny" });
    appendEvent(dir, { ...EVENT, decision: "allow" });
    const path = join(dir, "2026-08-14.jsonl");
    const kept = lines(dir, "2026-08-14.jsonl").filter((_, i) => i !== 1);
    writeFileSync(path, `${kept.join("\n")}\n`);
    expect(verifyLog(dir)).toMatchObject({ ok: false, line: 2 });

    writeFileSync(path, `${kept.join("\n")}\n${JSON.stringify({ ...EVENT })}\n`);
    expect(verifyLog(dir)).toMatchObject({ ok: false, line: 2 });
  });

  /**
   * The writer keeps no state: it reads the last line back every time, so a
   * proxy restart, or `missura approve` in its own process, continues the
   * chain rather than starting one — across day files too.
   */
  it("survives a restart and continues across day files", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    appendEvent(dir, { ...EVENT, ts: "2026-08-15T00:00:01.000Z" });
    // "Restart": nothing to reset — the next append re-reads the tail.
    appendEvent(dir, { ...EVENT, ts: "2026-08-15T09:00:00.000Z", decision: "allow" });

    const [last14] = lines(dir, "2026-08-14.jsonl");
    const [first15, second15] = lines(dir, "2026-08-15.jsonl");
    expect((JSON.parse(first15 ?? "") as { prev: string }).prev).toBe(sha256(last14 ?? ""));
    expect((JSON.parse(second15 ?? "") as { prev: string }).prev).toBe(sha256(first15 ?? ""));
    expect(verifyLog(dir)).toEqual({ ok: true, events: 3, files: 2 });
  });

  it("never files an event before the log's last line, whatever its own clock says", () => {
    const dir = tmpDir();
    appendEvent(dir, { ...EVENT, ts: "2026-08-15T00:00:01.000Z" });
    appendEvent(dir, { ...EVENT, ts: "2026-08-14T23:59:59.000Z" });
    expect(lines(dir, "2026-08-15.jsonl")).toHaveLength(2);
    expect(verifyLog(dir)).toEqual({ ok: true, events: 2, files: 1 });
  });

  it("reports an empty or absent log as intact and empty", () => {
    expect(verifyLog(tmpDir())).toEqual({ ok: true, events: 0, files: 0 });
    expect(verifyLog(join(tmpDir(), "never"))).toEqual({ ok: true, events: 0, files: 0 });
  });

  it("does not let a caller forge `prev`: the writer sets it", () => {
    const dir = tmpDir();
    appendEvent(dir, { ...EVENT, prev: "f".repeat(64) });
    const [first] = lines(dir, "2026-08-14.jsonl");
    expect((JSON.parse(first ?? "") as { prev: string }).prev).toBe(LOG_GENESIS);
  });
});

/**
 * The human's decision is a line in the same log (M4): who, what, when,
 * on which approval of which mission — and no body.
 */
describe("decision log — the human's decision", () => {
  it("builds the decision event from the record", () => {
    const ev = approvalDecisionEvent(RECORD, 1_700_000_060_500);
    expect(ev).toEqual({
      ts: "2023-11-14T22:14:20.500Z",
      provider: "github",
      operation: "missura.approval",
      action: "destroy",
      decision: "approved",
      reason: "decided by a human on the operator plane",
      missionId: "msn_dev",
      latencyMs: 0,
      actor: "ops@acme.io",
      viaOperation: "github.issue.comment.delete",
      approvalId: "apr_0123456789abcdef",
    });
    const denied = approvalDecisionEvent(
      { ...RECORD, decision: { decision: "denied", actor: "sam", at: 1 } },
      1000,
    );
    expect(denied.decision).toBe("denied");
    expect(denied.actor).toBe("sam");
  });

  it("refuses to describe a record nobody decided", () => {
    const pending: ApprovalRecord = { ...RECORD };
    delete pending.decision;
    expect(() => approvalDecisionEvent(pending, 0)).toThrow(/decided/);
  });
});
