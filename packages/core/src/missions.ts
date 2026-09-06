import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  approvalState,
  mergeApprovals,
  type ApprovalDecision,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApprovalView,
} from "./approvals";
import { newApproval, pendingViews, purgeUnreadable } from "./mission-approvals";
import {
  fileStamp,
  parseState,
  writeState,
  type StateFile,
} from "./mission-state";
import { connectionsFor, requireText, type CreateMission, type MissionRecord } from "./mission-record";
import { grantableOperations, type Operation } from "./operation";
import type { ResolvedScope } from "./resolved-scope";
import type { ScopeResolution } from "./entity-resolve";
import { scopeProvenance } from "./scope-provenance";
import { signMissionToken, verifyMissionToken } from "./token";

export type { CreateMission, MissionRecord } from "./mission-record";

/** The verbs every mission grants — the raw read path, and nothing that writes. */
const ALLOW = ["read", "search"] as const;

/**
 * The two keys a store needs: the HMAC key mission tokens are signed with,
 * and the vault key approval bodies are sealed under at rest (M3) — the
 * same key that protects the vendor credentials, so the state file is
 * exactly as private as the vault.
 */
export interface MissionKeys {
  signing: Buffer;
  seal: Buffer;
}

/**
 * Missions and their revocations, persisted as plain JSON (mode 0600). The file
 * holds no token material: a record is a description of a grant, never a
 * bearer of it, so leaking the state file leaks no capability.
 *
 * Every mutation writes synchronously and atomically (temp file + rename) — a
 * revoke that survived only in memory would be a revoke a crash silently
 * undoes, and a half-written file would parse as a shorter mission list.
 *
 * The file, not this object, is the store: `missura revoke` runs in a different
 * process from `missura run`, so an instance that only ever read at
 * construction would keep honouring a mission an operator called back, until
 * expiry. Every read path therefore re-reads the file when it changed, and
 * every write path merges what the file holds before replacing it.
 *
 * Failure semantics, deliberately asymmetric:
 *   - file missing, unreadable, or unparseable → keep the last known-good view.
 *     Signature and expiry stay the gate; a corrupt file does not open a door
 *     it was already keeping shut, nor slam every door shut on a typo.
 *   - a revocation this process has ever observed is permanent in memory. A
 *     rolled-back, truncated or rewritten file can add revocations, never
 *     remove one.
 */
export class MissionStore {
  private readonly stateFile: string;
  private readonly signingKey: Buffer;
  private readonly sealKey: Buffer;
  /**
   * The operations a name-grant may name (`grantableOperations`). Defaulted
   * to none, which refuses every name: a store nobody told what exists cannot
   * be talked into granting it.
   */
  private readonly catalogue: readonly Operation[];
  private records: MissionRecord[];
  /** The approvals hanging on those missions (M10). Merged forward-only. */
  private approvals: ApprovalRecord[] = [];
  /** jti → revocation time. Entries are added, never removed. */
  private readonly revoked = new Map<string, number>();
  /** The file's stamp as of the last successful read or write. */
  private stamp: string | undefined;

  constructor(
    stateFile: string,
    keys: MissionKeys,
    catalogue: readonly Operation[] = [],
  ) {
    this.stateFile = stateFile;
    this.signingKey = keys.signing;
    this.sealKey = keys.seal;
    this.catalogue = catalogue;
    this.records = [];
    if (existsSync(stateFile)) {
      // Stamped before the read: a write landing in between costs one redundant
      // re-read later, where the reverse order would lose the update entirely.
      const stamp = fileStamp(stateFile);
      // Fails closed at construction: a state file we cannot parse at all is a
      // startup error, not an empty mission list.
      this.adopt(parseState(readFileSync(stateFile, "utf8")));
      this.stamp = stamp;
    }
  }

  /** The earliest revocation wins: a re-read can add one, never move it later. */
  private noteRevoked(jti: string, revokedAt: number): void {
    const known = this.revoked.get(jti);
    if (known === undefined || revokedAt < known) this.revoked.set(jti, revokedAt);
  }

  /**
   * Takes on a freshly read view of the file, then re-applies every revocation
   * this instance already knows about: the file can only ever add to them.
   */
  private adopt(state: StateFile): void {
    for (const entry of state.revoked) this.noteRevoked(entry.jti, entry.revokedAt);
    for (const record of state.missions) {
      if (record.revokedAt !== undefined) {
        this.noteRevoked(record.jti, record.revokedAt);
      }
      const revokedAt = this.revoked.get(record.jti);
      if (revokedAt !== undefined) record.revokedAt = revokedAt;
    }
    this.records = state.missions;
    // Forward-only: a file that reads as "approved" cannot take back a
    // consumption this process already recorded (`mergeApprovals`).
    this.approvals = mergeApprovals(state.approvals, this.approvals);
  }

  /** The file as it stands, or nothing at all when it cannot be read. */
  private onDisk(): StateFile {
    try {
      return parseState(readFileSync(this.stateFile, "utf8"));
    } catch {
      return { missions: [], revoked: [], approvals: [] };
    }
  }

  /** Hot path: a single `stat` when nothing changed, a re-read when it did. */
  private refresh(): void {
    const stamp = fileStamp(this.stateFile);
    if (stamp === undefined || stamp === this.stamp) return;
    let state: StateFile;
    try {
      state = parseState(readFileSync(this.stateFile, "utf8"));
    } catch {
      // Mid-write or corrupt: keep the last known-good view and retry on the
      // next call — the stamp stays uncached on purpose.
      return;
    }
    this.stamp = stamp;
    this.adopt(state);
  }

  /**
   * Mints a mission. The RESOLVED scope is required, not derived here: which
   * connections a mission carries depends on what its entity links to, and this
   * store does not hold the entity graph. Both call sites — the CLI and the
   * operator API — resolve before minting anyway, because an unresolvable
   * scope must fail before a token exists.
   */
  create(
    input: CreateMission,
    resolved: ResolvedScope,
    /**
     * The graph's account of that scope, when the graph produced it. Optional,
     * and separate from `resolved`, because a mission may legitimately be
     * minted with no graph in the picture at all — a native-only scope resolves
     * without one, and that path must never depend on this argument.
     */
    resolution?: ScopeResolution,
  ): { record: MissionRecord; token: string } {
    // Before the write, so a mission another process minted since is not
    // dropped by this one's rewrite of the whole file.
    this.refresh();
    requireText("purpose", input.purpose);
    requireText("actor", input.actor);
    // Before the id and the token: a name the catalogue does not know is a
    // refused mint, not a minted mission that refuses everything.
    const granted = grantableOperations(input.allow ?? [], this.catalogue);
    const id = `msn_${randomBytes(8).toString("hex")}`;
    const token = signMissionToken(
      {
        id,
        purpose: input.purpose,
        actor: input.actor,
        scope: input.scope,
        connections: connectionsFor(resolved),
        allow: [...ALLOW, ...granted],
        // Field by field, and the id stays behind on the record: the token is
        // the one artefact the agent holds in full (`MissionDegradation`).
        degraded: (resolution?.degraded ?? []).map((d) => ({
          system: d.system,
          reason: d.reason,
        })),
      },
      { key: this.signingKey, ttlSeconds: input.ttlSeconds },
    );
    const claims = verifyMissionToken(token, { key: this.signingKey });
    const record: MissionRecord = {
      purpose: input.purpose,
      actor: input.actor,
      scope: input.scope,
      ttlSeconds: input.ttlSeconds,
      // As granted — checked and deduplicated — and only when something was:
      // the record is the operator's read of what this mission may write.
      ...(granted.length === 0 ? {} : { allow: granted }),
      id,
      jti: claims.jti,
      createdAt: claims.iat,
      expiresAt: claims.exp,
      // Projected through the whitelist rather than stored as handed over: the
      // caller's resolution object is not the shape that goes on disk.
      ...(resolution === undefined
        ? {}
        : { resolution: scopeProvenance(resolution) }),
    };
    this.records.push(record);
    this.persist();
    return { record, token };
  }

  /** Revokes a mission this store knows; an unknown id or jti throws. */
  revoke(idOrJti: string): MissionRecord {
    this.refresh();
    const record = this.records.find(
      (m) => m.id === idOrJti || m.jti === idOrJti,
    );
    if (!record) throw new Error(`unknown mission: ${idOrJti}`);
    // Idempotent (RFC 7009 semantics): a second revoke must not move the clock.
    if (record.revokedAt === undefined) {
      record.revokedAt = Math.floor(Date.now() / 1000);
      this.noteRevoked(record.jti, record.revokedAt);
      // The bodies go with the grant: `persist` purges every approval of a
      // mission that is no longer live, this one included.
      this.persist();
    }
    return record;
  }

  /**
   * Revokes a jti, whether or not a record for it exists here.
   *
   * The token, not the record, is what the proxy honours: a signature-valid
   * jti keeps working until expiry no matter what this store remembers about
   * it. So the revocation is written as a tombstone even with nothing to
   * attach it to — a revoke that reports success and does not deny is the one
   * failure an operator cannot see.
   */
  revokeJti(jti: string): void {
    this.refresh();
    if (this.revoked.has(jti)) return;
    const revokedAt = Math.floor(Date.now() / 1000);
    this.revoked.set(jti, revokedAt);
    const record = this.records.find((m) => m.jti === jti);
    if (record !== undefined) record.revokedAt = revokedAt;
    this.persist();
  }

  /**
   * The proxy's per-request question. Answered from the file's current state,
   * so an operator's revoke lands on the next call rather than at expiry.
   */
  isRevoked(jti: string): boolean {
    this.refresh();
    return this.revoked.has(jti);
  }

  /** Non-expired, non-revoked missions, in creation order. */
  active(now: number = Date.now()): MissionRecord[] {
    this.refresh();
    const seconds = Math.floor(now / 1000);
    return this.records.filter(
      (m) =>
        m.revokedAt === undefined &&
        !this.revoked.has(m.jti) &&
        m.expiresAt > seconds,
    );
  }

  /**
   * The mission an approval hangs on, live. Unknown, revoked and expired each
   * refuse by name: an approval is exactly as alive as its mission, and a
   * caller must never be able to use one past the grant it was asked under.
   */
  private liveMission(missionId: string, now: number): MissionRecord {
    const record = this.records.find((m) => m.id === missionId);
    if (record === undefined) throw new Error(`unknown mission: ${missionId}`);
    if (record.revokedAt !== undefined || this.revoked.has(record.jti)) {
      throw new Error(`mission ${missionId} is revoked`);
    }
    if (record.expiresAt <= Math.floor(now / 1000)) {
      throw new Error(`mission ${missionId} has expired`);
    }
    return record;
  }

  private approvalById(id: string): ApprovalRecord {
    const approval = this.approvals.find((a) => a.id === id);
    if (approval === undefined) throw new Error(`unknown approval: ${id}`);
    return approval;
  }

  /**
   * Writes an approval down, pending, on a live mission: what was asked and
   * the exact inner call(s) that would go (M10), sealed (M3). Nothing runs
   * here. One pending approval per target, few per mission, none too large
   * (`mission-approvals.ts`).
   */
  requestApproval(
    missionId: string,
    request: ApprovalRequest,
    now: number = Date.now(),
  ): ApprovalRecord {
    this.refresh();
    this.liveMission(missionId, now);
    const approval = newApproval(this.sealKey, this.approvals, missionId, request, now);
    this.approvals.push(approval);
    this.persist(now);
    return approval;
  }

  /**
   * THIS mission's approval by id, while the mission lives — `undefined` for
   * another mission's id, an id that never existed, and a mission that is
   * gone, all alike: the data plane must not be able to tell them apart.
   * The record, sealed: the data plane matches a re-request against
   * `requestHash` and never needs the body.
   */
  approvalFor(
    missionId: string,
    id: string,
    now: number = Date.now(),
  ): ApprovalRecord | undefined {
    this.refresh();
    const approval = this.approvals.find((a) => a.id === id && a.missionId === missionId);
    if (approval === undefined) return undefined;
    try {
      this.liveMission(missionId, now);
    } catch {
      return undefined;
    }
    return approval;
  }

  /**
   * What the operator has to decide: pending, on missions still live, with
   * the request opened for them to read. A read path that writes, once:
   * listing is where an expired mission's bodies are noticed, and they are
   * purged from the file before anything is shown.
   */
  pendingApprovals(now: number = Date.now()): ApprovalView[] {
    this.refresh();
    if (this.purge(now)) this.persist(now);
    const live = new Set(this.active(now).map((m) => m.id));
    return pendingViews(this.sealKey, this.approvals, live);
  }

  /**
   * Records a human's decision — and only records it. Once: a decision is
   * not something a second operator gets to flip, in either direction. A
   * denial is the end of the body: nobody reads it again, so it is purged.
   */
  decideApproval(
    id: string,
    decision: ApprovalDecision,
    actor: string,
    now: number = Date.now(),
  ): ApprovalRecord {
    this.refresh();
    const approval = this.approvalById(id);
    requireText("actor", actor);
    this.liveMission(approval.missionId, now);
    const state = approvalState(approval);
    if (state !== "pending") throw new Error(`approval ${id} is already ${state}`);
    approval.decision = { decision, actor, at: Math.floor(now / 1000) };
    this.persist(now);
    return approval;
  }

  /**
   * Spends an approved approval, at most once. Called BEFORE the call leaves,
   * so a request racing this one finds it consumed rather than approved — a
   * failed vendor call then costs a new approval, which is the safe side.
   * Spent is read no more: the body is purged with the same write.
   */
  consumeApproval(id: string, now: number = Date.now()): ApprovalRecord {
    this.refresh();
    const approval = this.approvalById(id);
    this.liveMission(approval.missionId, now);
    const state = approvalState(approval);
    if (state !== "approved") throw new Error(`approval ${id} is ${state}, not approved`);
    approval.consumedAt = Math.floor(now / 1000);
    this.persist(now);
    return approval;
  }

  /** Takes the bodies off every approval nobody will read again. */
  private purge(now: number): boolean {
    const { approvals, purged } = purgeUnreadable(
      this.approvals,
      this.records,
      new Set(this.revoked.keys()),
      now,
    );
    if (purged) this.approvals = approvals;
    return purged;
  }

  /**
   * Writes the whole file, so it first merges what the file holds.
   *
   * `refresh` is a read optimisation guarded by a stat, not a lock: the file
   * can have moved since — inside the same millisecond, at the same size, or
   * between this store's last read and this write. Overwriting blind is how
   * two processes minting at once drop one of the two missions, whose token
   * then keeps verifying with nothing left to revoke.
   *
   * This narrows that window to the merge-and-rename itself; it does not close
   * it. Two writers can still interleave inside it — a real fix is a lock file
   * or a single writer, and neither is M2.
   */
  private persist(now: number = Date.now()): void {
    const disk = this.onDisk();
    for (const entry of disk.revoked) this.noteRevoked(entry.jti, entry.revokedAt);
    for (const record of disk.missions) {
      if (record.revokedAt !== undefined) {
        this.noteRevoked(record.jti, record.revokedAt);
      }
    }
    // File order first, ours appended; a record held in both is ours, since
    // every revocation either side knows about is re-applied by `adopt`.
    const byId = new Map<string, MissionRecord>();
    for (const record of disk.missions) byId.set(record.id, record);
    for (const record of this.records) byId.set(record.id, record);
    this.adopt({
      missions: [...byId.values()],
      revoked: [],
      approvals: mergeApprovals(disk.approvals, this.approvals),
    });
    // Last, on the merged view: a body the file still held for a mission
    // that is dead here leaves with this write, whichever side wrote it.
    this.purge(now);

    writeState(this.stateFile, {
      missions: this.records,
      revoked: [...this.revoked].map(([jti, revokedAt]) => ({ jti, revokedAt })),
      approvals: this.approvals,
    });
    // Our own write is not a change to react to; anyone else's still is.
    this.stamp = fileStamp(this.stateFile);
  }
}
