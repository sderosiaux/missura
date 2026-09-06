import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovalRefusedError,
  approvalState,
  MAX_APPROVAL_BYTES,
  type ApprovalRequest,
} from "./approvals";
import { MissionStore, type CreateMission, type MissionKeys } from "./missions";
import { parseState } from "./mission-state";
import type { ResolvedScope } from "./resolved-scope";

/**
 * BODIES AT REST (M3). An approval holds the text a customer will receive,
 * and a human may take hours to read it, so it must persist until decided —
 * but "no bodies stored" is the doctrine, and a state file is the one thing
 * on this machine that gets pasted into a ticket. So: sealed under the vault
 * key while a human still has to read it, capped in size, capped in count,
 * and PURGED the moment nobody does — denied, consumed, expired, revoked.
 * What outlives a decision is what an audit needs: ids, operation, actor,
 * timestamps, and the hash a re-POST is matched against.
 */

const KEYS: MissionKeys = { signing: Buffer.alloc(32, 3), seal: Buffer.alloc(32, 5) };
const OTHER_SEAL: MissionKeys = { signing: KEYS.signing, seal: Buffer.alloc(32, 6) };

const INPUT: CreateMission = {
  purpose: "support case 482",
  actor: "sam@acme.io",
  scope: { entity: "customer:acme" },
  ttlSeconds: 900,
};
const RESOLVED: ResolvedScope = { githubRepos: [], zendeskOrganizationIds: ["4200"] };

const REPLY_TEXT = "Hi Dana, the March invoice is refunded in full. Sorry again — Sam";
const REPLY: ApprovalRequest = {
  operation: "zendesk.ticket.reply",
  params: { ticket: 35, body: REPLY_TEXT },
  planned: [
    {
      method: "PUT",
      path: "/api/v2/tickets/35",
      body: JSON.stringify({ ticket: { comment: { body: REPLY_TEXT, public: true } } }),
    },
  ],
};

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "missura-at-rest-")), "state.json");
}

function minted(): { store: MissionStore; missionId: string; path: string } {
  const path = statePath();
  const store = new MissionStore(path, KEYS);
  const { record } = store.create(INPUT, RESOLVED);
  return { store, missionId: record.id, path };
}

function raw(path: string): string {
  return readFileSync(path, "utf8");
}

describe("approval bodies at rest — sealed while pending", () => {
  it("writes no plaintext body to the file, and reads it back opened for the operator", () => {
    const { store, missionId, path } = minted();
    const approval = store.requestApproval(missionId, REPLY);

    const file = raw(path);
    expect(file).not.toContain(REPLY_TEXT);
    expect(file).not.toContain("Dana");
    expect(file).toContain(approval.id);
    expect(approval).not.toHaveProperty("params");
    expect(approval).not.toHaveProperty("planned");
    expect(typeof approval.requestHash).toBe("string");

    const [pending] = store.pendingApprovals();
    expect(pending).toMatchObject({ id: approval.id, params: REPLY.params, planned: REPLY.planned });
    // A fresh store with the same keys — `missura approvals` in its own process.
    const [again] = new MissionStore(path, KEYS).pendingApprovals();
    expect(again?.planned).toEqual(REPLY.planned);
  });

  it("fails closed under another seal key rather than serving garbage", () => {
    const { store, missionId, path } = minted();
    store.requestApproval(missionId, REPLY);
    expect(() => new MissionStore(path, OTHER_SEAL).pendingApprovals()).toThrow(/decrypt|seal/i);
  });

  it("refuses a request over MAX_APPROVAL_BYTES — a reply is text, not a blob", () => {
    const { store, missionId, path } = minted();
    expect(MAX_APPROVAL_BYTES).toBeLessThanOrEqual(64 * 1024);
    const blob = "x".repeat(MAX_APPROVAL_BYTES);
    const oversize: ApprovalRequest = {
      ...REPLY,
      params: { ticket: 35, body: blob },
      planned: [{ method: "PUT", path: "/api/v2/tickets/35", body: blob }],
    };
    expect(() => store.requestApproval(missionId, oversize)).toThrow(ApprovalRefusedError);
    expect(() => store.requestApproval(missionId, oversize)).toThrow(/too large/);
    expect(raw(path)).not.toContain("xxxx");
    expect(store.pendingApprovals()).toEqual([]);
  });
});

/**
 * THE PURGE. After each of the four events the file holds the record — id,
 * mission, operation, hash, decision, timestamps — and not one byte of the
 * body, in the clear or sealed.
 */
describe("approval bodies at rest — purged once nobody has to read them", () => {
  function sealedOnDisk(path: string, id: string): boolean {
    const record = parseState(raw(path)).approvals.find((a) => a.id === id);
    return record?.sealed !== undefined;
  }

  it("on denial", () => {
    const { store, missionId, path } = minted();
    const { id, requestHash } = store.requestApproval(missionId, REPLY);
    expect(sealedOnDisk(path, id)).toBe(true);
    store.decideApproval(id, "denied", "ops@acme.io");

    expect(sealedOnDisk(path, id)).toBe(false);
    const kept = parseState(raw(path)).approvals.find((a) => a.id === id);
    expect(kept).toMatchObject({
      id,
      missionId,
      operation: REPLY.operation,
      requestHash,
      decision: { decision: "denied", actor: "ops@acme.io" },
    });
    expect(raw(path)).not.toContain(REPLY_TEXT);
  });

  it("on consumption, with the hash still there to match a replay against", () => {
    const { store, missionId, path } = minted();
    const { id, requestHash } = store.requestApproval(missionId, REPLY);
    store.decideApproval(id, "approved", "ops@acme.io");
    expect(sealedOnDisk(path, id)).toBe(true);
    store.consumeApproval(id);

    expect(sealedOnDisk(path, id)).toBe(false);
    const kept = store.approvalFor(missionId, id);
    expect(kept === undefined ? undefined : approvalState(kept)).toBe("consumed");
    expect(kept?.requestHash).toBe(requestHash);
  });

  it("on revocation of the mission", () => {
    const { store, missionId, path } = minted();
    const { id } = store.requestApproval(missionId, REPLY);
    store.revoke(missionId);
    expect(sealedOnDisk(path, id)).toBe(false);
    expect(parseState(raw(path)).approvals.map((a) => a.id)).toEqual([id]);
  });

  it("on revocation by jti, from another store on the same file", () => {
    const { store, missionId, path } = minted();
    const { id } = store.requestApproval(missionId, REPLY);
    const jti = new MissionStore(path, KEYS).active().find((m) => m.id === missionId)?.jti ?? "";
    new MissionStore(path, KEYS).revokeJti(jti);
    expect(sealedOnDisk(path, id)).toBe(false);
    expect(store.pendingApprovals()).toEqual([]);
  });

  it("on expiry of the mission, swept by the next listing or write", () => {
    const { store, missionId, path } = minted();
    const { id } = store.requestApproval(missionId, REPLY);
    const afterExpiry = Date.now() + (INPUT.ttlSeconds + 1) * 1000;

    expect(store.pendingApprovals(afterExpiry)).toEqual([]);
    expect(sealedOnDisk(path, id)).toBe(false);
    expect(raw(path)).not.toContain(REPLY_TEXT);
    // Purged in every copy: a second store that had it opened in memory too.
    expect(new MissionStore(path, KEYS).approvalFor(missionId, id, afterExpiry)).toBeUndefined();
  });
});
