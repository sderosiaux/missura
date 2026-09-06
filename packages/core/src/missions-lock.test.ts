import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalState, type ApprovalRequest } from "./approvals";
import { LOCK_TIMEOUT_MS, lockPath, STALE_LOCK_MS } from "./mission-state";
import { MissionStore, type CreateMission, type MissionKeys } from "./missions";
import type { ResolvedScope } from "./resolved-scope";

/**
 * TWO PROCESSES, ONE FILE (L7). `missura run` consumes an approval while
 * `missura approve` in another process still holds "approved" in memory. A
 * record must never move backwards on disk — consumed is final, because a
 * consumed approval that reads as approved again is a write that runs
 * twice — whichever process writes last, and whichever restarts.
 *
 * Two mechanisms, both pinned here: the forward-only merge on every load
 * and every persist, and a lock around persist's read-merge-write, which is
 * the one window the merge alone could not close.
 */

const KEYS: MissionKeys = { signing: Buffer.alloc(32, 3), seal: Buffer.alloc(32, 4) };
const INPUT: CreateMission = {
  purpose: "support case 482",
  actor: "sam@acme.io",
  scope: { entity: "customer:acme" },
  ttlSeconds: 900,
};
const RESOLVED: ResolvedScope = { githubRepos: [{ repo: "acme-corp/product" }] };
const REQUEST: ApprovalRequest = {
  operation: "github.issue.comment.delete",
  connector: "github",
  effect: "destroy",
  params: { repo: "acme-corp/product", comment: 9001 },
  planned: [{ method: "DELETE", path: "/repos/acme-corp/product/issues/comments/9001", body: "" }],
};

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "missura-lock-")), "missions.json");
}

function stateOf(store: MissionStore, missionId: string, id: string): string | undefined {
  const record = store.approvalFor(missionId, id);
  return record === undefined ? undefined : approvalState(record);
}

describe("mission store — two processes on one file never move an approval backwards", () => {
  it("a stale 'approved' in one process cannot overwrite the other's 'consumed', on persist or on load", () => {
    const path = statePath();
    const proxy = new MissionStore(path, KEYS);
    const { record } = proxy.create(INPUT, RESOLVED);
    const { id } = proxy.requestApproval(record.id, REQUEST);

    const cli = new MissionStore(path, KEYS);
    cli.decideApproval(id, "approved", "ops@acme.io");
    // The proxy spends it. The CLI still holds "approved" in memory.
    proxy.consumeApproval(id);
    expect(stateOf(cli, record.id, id)).toBe("consumed");

    // The CLI writes for another reason: its rewrite merges, and consumed stays.
    cli.revokeJti("11111111-1111-4111-8111-111111111111");
    expect(stateOf(new MissionStore(path, KEYS), record.id, id)).toBe("consumed");
    // The proxy restarts: disk says consumed, and so does the fresh process.
    expect(stateOf(new MissionStore(path, KEYS), record.id, id)).toBe("consumed");
    expect(() => proxy.consumeApproval(id)).toThrow(/consumed/);
  });

  /**
   * The window the merge could not close: a process that read the file
   * before another's rename and writes after it. Pinned the way the
   * persistence test pins the mint race — the file moves under the store
   * without its stamp moving — with the disk holding "consumed" and the
   * store about to rewrite "approved".
   */
  it("a rewrite from a store whose view predates a consumption keeps the consumption", () => {
    const path = statePath();
    const proxy = new MissionStore(path, KEYS);
    const { record } = proxy.create(INPUT, RESOLVED);
    const { id } = proxy.requestApproval(record.id, REQUEST);
    const cli = new MissionStore(path, KEYS);
    cli.decideApproval(id, "approved", "ops@acme.io");

    const pinned = new Date(Math.floor(statSync(path).mtimeMs));
    utimesSync(path, pinned, pinned);
    const before = statSync(path);
    proxy.consumeApproval(id);
    utimesSync(path, pinned, pinned);
    // Only when the file kept its size does the store's stamp stay fooled;
    // either way, the write below must not regress the record.
    const stale = statSync(path).size === before.size;

    cli.revokeJti("22222222-2222-4222-8222-222222222222");

    expect(stateOf(new MissionStore(path, KEYS), record.id, id)).toBe("consumed");
    expect(stale || stateOf(cli, record.id, id) === "consumed").toBe(true);
  });
});

describe("mission store — the write lock", () => {
  it("refuses to write while another process holds the lock, and never clobbers the file", () => {
    const path = statePath();
    const store = new MissionStore(path, KEYS, [], { lockTimeoutMs: 40 });
    const { record } = store.create(INPUT, RESOLVED);
    writeFileSync(lockPath(path), String(process.pid));

    expect(() => store.requestApproval(record.id, REQUEST)).toThrow(/locked/);
    expect(new MissionStore(path, KEYS).pendingApprovals()).toEqual([]);
    expect(LOCK_TIMEOUT_MS).toBeGreaterThan(40);
  });

  it("breaks a lock left behind by a dead process", () => {
    const path = statePath();
    const store = new MissionStore(path, KEYS, [], { lockTimeoutMs: 40 });
    const { record } = store.create(INPUT, RESOLVED);
    writeFileSync(lockPath(path), "dead");
    const old = new Date(Date.now() - STALE_LOCK_MS - 1000);
    utimesSync(lockPath(path), old, old);

    const { id } = store.requestApproval(record.id, REQUEST);
    expect(new MissionStore(path, KEYS).pendingApprovals().map((a) => a.id)).toEqual([id]);
  });
});
