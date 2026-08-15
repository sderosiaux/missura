import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  fileStamp,
  parseState,
  writeState,
  type StateFile,
} from "./mission-state";
import type { ResolvedScope } from "./entities";
import {
  signMissionToken,
  verifyMissionToken,
  type MissionScope,
} from "./token";

export interface CreateMission {
  purpose: string;
  actor: string;
  scope: MissionScope;
  ttlSeconds: number;
}

export interface MissionRecord extends CreateMission {
  id: string;
  jti: string;
  /** Epoch seconds, aligned with the token's `iat`/`exp`. */
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

/** Capabilities a mission grants in M2 — read-only, deliberately. */
const ALLOW = ["read", "search"] as const;

function requireText(field: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required and must not be empty`);
  }
  return value;
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
  private records: MissionRecord[];
  /** jti → revocation time. Entries are added, never removed. */
  private readonly revoked = new Map<string, number>();
  /** The file's stamp as of the last successful read or write. */
  private stamp: string | undefined;

  constructor(stateFile: string, signingKey: Buffer) {
    this.stateFile = stateFile;
    this.signingKey = signingKey;
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
  }

  /** The file as it stands, or nothing at all when it cannot be read. */
  private onDisk(): StateFile {
    try {
      return parseState(readFileSync(this.stateFile, "utf8"));
    } catch {
      return { missions: [], revoked: [] };
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
   * connections a mission carries depends on what its entity maps to, and this
   * store does not hold the entity map. Both call sites — the CLI and the
   * operator API — resolve before minting anyway, because an unresolvable
   * scope must fail before a token exists.
   */
  create(
    input: CreateMission,
    resolved: ResolvedScope,
  ): { record: MissionRecord; token: string } {
    // Before the write, so a mission another process minted since is not
    // dropped by this one's rewrite of the whole file.
    this.refresh();
    requireText("purpose", input.purpose);
    requireText("actor", input.actor);
    const id = `msn_${randomBytes(8).toString("hex")}`;
    const token = signMissionToken(
      {
        id,
        purpose: input.purpose,
        actor: input.actor,
        scope: input.scope,
        connections: connectionsFor(resolved),
        allow: ALLOW,
      },
      { key: this.signingKey, ttlSeconds: input.ttlSeconds },
    );
    const claims = verifyMissionToken(token, { key: this.signingKey });
    const record: MissionRecord = {
      ...input,
      id,
      jti: claims.jti,
      createdAt: claims.iat,
      expiresAt: claims.exp,
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
   * or a single writer, and neither is M2 (docs/SPEC.md §5).
   */
  private persist(): void {
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
    this.adopt({ missions: [...byId.values()], revoked: [] });

    writeState(this.stateFile, {
      missions: this.records,
      revoked: [...this.revoked].map(([jti, revokedAt]) => ({ jti, revokedAt })),
    });
    // Our own write is not a change to react to; anyone else's still is.
    this.stamp = fileStamp(this.stateFile);
  }
}

/**
 * A connection is granted only if the RESOLVED scope proves a target for it.
 *
 * Read off the business scope instead, a mission scoped `{customer: "acme"}`
 * whose entity maps `github.repos` would carry `linear` and not `github`:
 * every GitHub call refused on the connection check, and the entity map's
 * `github.repos` looking load-bearing while doing nothing. The mirror case is
 * a customer with no `linear.customer`, which now carries no linear connection
 * — there is no customer to narrow to, so there is nothing to grant.
 */
export function connectionsFor(scope: ResolvedScope): string[] {
  const connections: string[] = [];
  if (scope.linearCustomerId !== undefined && scope.linearCustomerId !== "") {
    connections.push("linear");
  }
  if (scope.githubRepos.length > 0) connections.push("github");
  if ((scope.zendeskOrganizationIds ?? []).length > 0) {
    connections.push("zendesk");
  }
  return connections;
}
