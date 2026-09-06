import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalState, mergeApprovals, type ApprovalRecord } from "./approvals";
import { MissionStore, type CreateMission } from "./missions";
import { parseState } from "./mission-state";
import type { ResolvedScope } from "./resolved-scope";

/**
 * THE APPROVAL RECORD (M10): a `destroy` or `egress` operation does not run
 * on request — it is written down, on the mission, as the exact inner call
 * that WOULD go, and the agent comes back once a human has decided. The
 * mission store is the only state: no queue, no wait, and the mission's own
 * TTL bounds every approval on it.
 */

const KEY = Buffer.alloc(32, 3);

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "missura-approvals-")), "state.json");
}

const INPUT: CreateMission = {
  purpose: "support case 482",
  actor: "sam@acme.io",
  scope: { entity: "customer:acme" },
  ttlSeconds: 900,
};

const RESOLVED: ResolvedScope = { githubRepos: [{ repo: "acme-corp/product" }] };

const REQUEST = {
  operation: "github.issue.comment.delete",
  params: { repo: "acme-corp/product", comment: 9001 },
  planned: [
    { method: "DELETE", path: "/repos/acme-corp/product/issues/comments/9001", body: "" },
  ],
};

function minted(path = statePath()): { store: MissionStore; missionId: string; path: string } {
  const store = new MissionStore(path, KEY);
  const { record } = store.create(INPUT, RESOLVED);
  return { store, missionId: record.id, path };
}

describe("mission store — requesting an approval", () => {
  it("records the operation, its parameters and the planned call, pending, on the mission", () => {
    const { store, missionId } = minted();
    const approval = store.requestApproval(missionId, REQUEST);

    expect(approval.id).toMatch(/^apr_[0-9a-f]{16}$/);
    expect(approval).toMatchObject({ missionId, ...REQUEST });
    expect(approval.requestedAt).toBeGreaterThan(0);
    expect(approvalState(approval)).toBe("pending");
    expect(store.approvalFor(missionId, approval.id)).toEqual(approval);
    expect(store.pendingApprovals().map((a) => a.id)).toEqual([approval.id]);
  });

  it("refuses a mission it does not know, and one that was revoked", () => {
    const { store, missionId } = minted();
    expect(() => store.requestApproval("msn_nope", REQUEST)).toThrow(/unknown mission/);
    store.revoke(missionId);
    expect(() => store.requestApproval(missionId, REQUEST)).toThrow(/revoked/);
    expect(store.pendingApprovals()).toEqual([]);
  });

  it("persists to the state file, without any token material", () => {
    const { store, missionId, path } = minted();
    const { token } = store.create(INPUT, RESOLVED);
    const approval = store.requestApproval(missionId, REQUEST);
    const raw = readFileSync(path, "utf8");

    expect(raw).not.toContain(token);
    expect(parseState(raw).approvals).toEqual([approval]);
    expect(new MissionStore(path, KEY).approvalFor(missionId, approval.id)).toEqual(approval);
  });
});

describe("mission store — deciding an approval executes nothing", () => {
  it("records who approved and when, and the record says approved", () => {
    const { store, missionId } = minted();
    const { id } = store.requestApproval(missionId, REQUEST);
    const decided = store.decideApproval(id, "approved", "ops@acme.io");

    expect(decided.decision).toMatchObject({ decision: "approved", actor: "ops@acme.io" });
    expect(decided.decision?.at).toBeGreaterThan(0);
    expect(approvalState(decided)).toBe("approved");
    expect(store.pendingApprovals()).toEqual([]);
    // The planned call is still exactly what was requested: deciding is a
    // record, never a run, and the store holds nothing that could run one.
    expect(decided.planned).toEqual(REQUEST.planned);
  });

  it("records a denial the same way", () => {
    const { store, missionId } = minted();
    const { id } = store.requestApproval(missionId, REQUEST);
    expect(approvalState(store.decideApproval(id, "denied", "ops@acme.io"))).toBe("denied");
  });

  it("refuses to decide twice, an unknown id, a blank actor, and a decision on a dead mission", () => {
    const { store, missionId } = minted();
    const { id } = store.requestApproval(missionId, REQUEST);
    store.decideApproval(id, "denied", "ops@acme.io");
    expect(() => store.decideApproval(id, "approved", "ops@acme.io")).toThrow(/already denied/);
    expect(() => store.decideApproval("apr_nope", "approved", "ops")).toThrow(/unknown approval/);

    const second = store.requestApproval(missionId, REQUEST);
    expect(() => store.decideApproval(second.id, "approved", "  ")).toThrow(/actor/);
    store.revoke(missionId);
    expect(() => store.decideApproval(second.id, "approved", "ops@acme.io")).toThrow(/revoked/);
  });

  it("is seen by a fresh store — the proxy and `missura approve` are two processes", () => {
    const { store, missionId, path } = minted();
    const { id } = store.requestApproval(missionId, REQUEST);
    new MissionStore(path, KEY).decideApproval(id, "approved", "ops@acme.io");
    const seen = store.approvalFor(missionId, id);
    expect(seen === undefined ? undefined : approvalState(seen)).toBe("approved");
  });
});

describe("mission store — consuming an approval", () => {
  it("marks an approved approval consumed, once", () => {
    const { store, missionId } = minted();
    const { id } = store.requestApproval(missionId, REQUEST);
    store.decideApproval(id, "approved", "ops@acme.io");
    const consumed = store.consumeApproval(id);

    expect(consumed.consumedAt).toBeGreaterThan(0);
    expect(approvalState(consumed)).toBe("consumed");
    expect(() => store.consumeApproval(id)).toThrow(/consumed/);
  });

  it("refuses a pending, a denied and an unknown approval", () => {
    const { store, missionId } = minted();
    const pending = store.requestApproval(missionId, REQUEST);
    expect(() => store.consumeApproval(pending.id)).toThrow(/pending/);
    const denied = store.requestApproval(missionId, REQUEST);
    store.decideApproval(denied.id, "denied", "ops@acme.io");
    expect(() => store.consumeApproval(denied.id)).toThrow(/denied/);
    expect(() => store.consumeApproval("apr_nope")).toThrow(/unknown approval/);
  });
});

describe("mission store — an approval belongs to one mission and lives as long as it", () => {
  it("answers nothing for another mission's id, exactly as for an id that never existed", () => {
    const { store, missionId } = minted();
    const other = store.create(INPUT, RESOLVED).record.id;
    const { id } = store.requestApproval(missionId, REQUEST);

    expect(store.approvalFor(other, id)).toBeUndefined();
    expect(store.approvalFor(other, "apr_0000000000000000")).toBeUndefined();
    expect(store.approvalFor(missionId, id)).toBeDefined();
  });

  it("is unusable once the mission expired or was revoked, and no longer listed", () => {
    const { store, missionId } = minted();
    const { id } = store.requestApproval(missionId, REQUEST);
    store.decideApproval(id, "approved", "ops@acme.io");
    const afterExpiry = (INPUT.ttlSeconds + 1) * 1000 + Date.now();

    expect(store.approvalFor(missionId, id, afterExpiry)).toBeUndefined();
    expect(store.pendingApprovals(afterExpiry)).toEqual([]);
    expect(() => store.consumeApproval(id, afterExpiry)).toThrow(/expired/);

    store.revoke(missionId);
    expect(store.approvalFor(missionId, id)).toBeUndefined();
    expect(() => store.consumeApproval(id)).toThrow(/revoked/);
  });
});

/**
 * Two processes write the one file. A stale rewrite must never move an
 * approval BACK — an approval that was consumed and reads as approved again
 * is a write that runs twice.
 */
describe("mergeApprovals — the further-along record wins", () => {
  const base: ApprovalRecord = {
    id: "apr_1",
    missionId: "msn_1",
    requestedAt: 1,
    ...REQUEST,
  };
  const approved: ApprovalRecord = {
    ...base,
    decision: { decision: "approved", actor: "ops", at: 2 },
  };
  const consumed: ApprovalRecord = { ...approved, consumedAt: 3 };

  it("keeps a decision over a pending copy, and a consumption over a decided copy", () => {
    expect(mergeApprovals([base], [approved])).toEqual([approved]);
    expect(mergeApprovals([approved], [base])).toEqual([approved]);
    expect(mergeApprovals([consumed], [approved])).toEqual([consumed]);
    expect(mergeApprovals([approved], [consumed])).toEqual([consumed]);
  });

  it("keeps records only one side holds, file order first", () => {
    const other: ApprovalRecord = { ...base, id: "apr_2" };
    expect(mergeApprovals([other], [base])).toEqual([other, base]);
  });
});

describe("state file — approvals", () => {
  it("reads a file written before approvals existed as holding none", () => {
    expect(parseState('{"missions":[],"revoked":[]}').approvals).toEqual([]);
  });

  it("fails closed on a malformed approval entry", () => {
    expect(() =>
      parseState('{"missions":[],"revoked":[],"approvals":[{"id":"apr_1"}]}'),
    ).toThrow(/approval/);
  });
});
