import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { SECRET_FILE_MODE } from "./keys";
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

interface StateFile {
  missions: MissionRecord[];
}

function requireText(field: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required and must not be empty`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fails closed: a state file we cannot fully parse is an error, not an empty list. */
function parseState(raw: string): MissionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("mission state file is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.missions)) {
    throw new Error("mission state file is malformed: missions");
  }
  return parsed.missions.map((entry: unknown): MissionRecord => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.jti !== "string" ||
      typeof entry.purpose !== "string" ||
      typeof entry.actor !== "string" ||
      typeof entry.createdAt !== "number" ||
      typeof entry.expiresAt !== "number" ||
      typeof entry.ttlSeconds !== "number" ||
      !isRecord(entry.scope)
    ) {
      throw new Error("mission state file is malformed: mission entry");
    }
    return entry as unknown as MissionRecord;
  });
}

/**
 * Identity of the state file's current content, cheap enough for the hot path:
 * one `stat`, no read. Size alone would miss an equal-length rewrite and
 * mtime alone can be coarse, so the two are used together.
 */
function fileStamp(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return `${String(stats.mtimeMs)}:${String(stats.size)}`;
  } catch {
    return undefined;
  }
}

/**
 * Missions and their revocations, persisted as plain JSON (mode 0600). The file
 * holds no token material: a record is a description of a grant, never a
 * bearer of it, so leaking the state file leaks no capability.
 *
 * Every mutation writes synchronously — a revoke that survives only in memory
 * would be a revoke that a crash silently undoes.
 *
 * The file, not this object, is the store: `missura revoke` runs in a different
 * process from `missura run`, so an instance that only ever read at
 * construction would keep honouring a mission an operator called back, until
 * expiry. Every read path therefore re-reads the file when it changed.
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

  /**
   * Takes on a freshly read view of the file, then re-applies every revocation
   * this instance already knows about: the file can only ever add to them.
   */
  private adopt(records: MissionRecord[]): void {
    for (const record of records) {
      const known = this.revoked.get(record.jti);
      if (
        record.revokedAt !== undefined &&
        (known === undefined || record.revokedAt < known)
      ) {
        this.revoked.set(record.jti, record.revokedAt);
      }
      const revokedAt = this.revoked.get(record.jti);
      if (revokedAt !== undefined) record.revokedAt = revokedAt;
    }
    this.records = records;
  }

  /** Hot path: a single `stat` when nothing changed, a re-read when it did. */
  private refresh(): void {
    const stamp = fileStamp(this.stateFile);
    if (stamp === undefined || stamp === this.stamp) return;
    let records: MissionRecord[];
    try {
      records = parseState(readFileSync(this.stateFile, "utf8"));
    } catch {
      // Mid-write or corrupt: keep the last known-good view and retry on the
      // next call — the stamp stays uncached on purpose.
      return;
    }
    this.stamp = stamp;
    this.adopt(records);
  }

  create(input: CreateMission): { record: MissionRecord; token: string } {
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
        connections: connectionsFor(input.scope),
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

  revoke(idOrJti: string): MissionRecord {
    this.refresh();
    const record = this.records.find(
      (m) => m.id === idOrJti || m.jti === idOrJti,
    );
    if (!record) throw new Error(`unknown mission: ${idOrJti}`);
    // Idempotent (RFC 7009 semantics): a second revoke must not move the clock.
    if (record.revokedAt === undefined) {
      record.revokedAt = Math.floor(Date.now() / 1000);
      this.revoked.set(record.jti, record.revokedAt);
      this.persist();
    }
    return record;
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

  private persist(): void {
    const state: StateFile = { missions: this.records };
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.stateFile, JSON.stringify(state), {
      mode: SECRET_FILE_MODE,
    });
    // Our own write is not a change to react to; anyone else's still is.
    this.stamp = fileStamp(this.stateFile);
  }
}

/** A connection is granted only if the scope proves a target for it. */
export function connectionsFor(scope: MissionScope): string[] {
  const connections: string[] = [];
  if (scope.customer !== undefined && scope.customer !== "") {
    connections.push("linear");
  }
  if (scope.repos && scope.repos.length > 0) connections.push("github");
  return connections;
}
