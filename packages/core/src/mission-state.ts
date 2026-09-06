import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseApprovals, type ApprovalRecord } from "./approvals";
import { SECRET_FILE_MODE } from "./keys";
import type { MissionRecord } from "./mission-record";

/**
 * A revocation that outlives its record. Revoking by token has to work on a
 * jti this store has no mission for — otherwise a revoke can report success
 * while the token it names keeps being honoured.
 */
export interface RevocationEntry {
  jti: string;
  revokedAt: number;
}

export interface StateFile {
  missions: MissionRecord[];
  revoked: RevocationEntry[];
  /** The pending and decided approvals, beside the missions they hang on (M10). */
  approvals: ApprovalRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMissions(value: unknown): MissionRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("mission state file is malformed: missions");
  }
  return value.map((entry: unknown): MissionRecord => {
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

/** Absent is a file written before tombstones existed, not a malformed one. */
function parseRevoked(value: unknown): RevocationEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("mission state file is malformed: revoked");
  }
  return value.map((entry: unknown): RevocationEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.jti !== "string" ||
      typeof entry.revokedAt !== "number"
    ) {
      throw new Error("mission state file is malformed: revoked entry");
    }
    return { jti: entry.jti, revokedAt: entry.revokedAt };
  });
}

/** Fails closed: a state file we cannot fully parse is an error, not an empty list. */
export function parseState(raw: string): StateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("mission state file is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("mission state file is malformed: missions");
  }
  return {
    missions: parseMissions(parsed.missions),
    revoked: parseRevoked(parsed.revoked),
    approvals: parseApprovals(parsed.approvals),
  };
}

/**
 * Identity of the state file's current content, cheap enough for the hot path:
 * one `stat`, no read. Size alone would miss an equal-length rewrite and
 * mtime alone can be coarse, so the two are used together. A read optimisation
 * only — never a lock, and never proof that nothing changed.
 */
export function fileStamp(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return `${String(stats.mtimeMs)}:${String(stats.size)}`;
  } catch {
    return undefined;
  }
}

/** How long a writer waits for the lock before failing closed. */
export const LOCK_TIMEOUT_MS = 2_000;
/** A lock this old belongs to a process that died holding it: broken, not honoured. */
export const STALE_LOCK_MS = 10_000;
const LOCK_POLL_MS = 5;

export function lockPath(path: string): string {
  return `${path}.lock`;
}

/** A synchronous pause: the store is synchronous, and a busy loop is worse. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * THE WRITE LOCK (L7). `persist` reads the file, merges, and renames over
 * it; two processes interleaving inside that window — `missura approve`
 * reading before `missura run`'s rename and writing after — could put an
 * "approved" back over a "consumed", and on the next restart disk wins. The
 * forward-only merge cannot close that window on its own, so the window is
 * held: one writer at a time, by an `O_EXCL` lock file beside the state.
 *
 * A lock is honoured for `STALE_LOCK_MS` at most: a process that died
 * holding it must not wedge every operator command after it. A writer that
 * cannot get the lock in `LOCK_TIMEOUT_MS` throws — a proxy request then
 * fails closed (500) rather than writing blind.
 */
export function withStateLock<T>(path: string, timeoutMs: number, fn: () => T): T {
  const lock = lockPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lock, "wx", SECRET_FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        // Released between our open and our stat: try again at once.
        continue;
      }
      if (age > STALE_LOCK_MS) {
        try {
          unlinkSync(lock);
        } catch {
          // Someone else broke it first; try again.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`mission state file is locked by another process: ${lock}`);
      }
      pause(LOCK_POLL_MS);
      continue;
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        // Broken as stale by another process meanwhile: nothing to release.
      }
    }
  }
}

/**
 * Replaces the state file in one step: a temp file in the same directory
 * (so `rename` stays within one filesystem), then a rename over the target.
 * A reader — this process's own `refresh`, another process's proxy — sees
 * either the whole old file or the whole new one, never a half-written one
 * that would parse as a shorter mission list.
 *
 * The mode is set on the temp file rather than passed and forgotten:
 * `writeFileSync`'s `mode` is masked by the umask and ignored outright on an
 * existing file, so a state file that once got loose permissions would keep
 * them forever. Renaming a 0600 temp over it also means the target is never
 * briefly readable by anyone else.
 */
export function writeState(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: SECRET_FILE_MODE });
    chmodSync(temp, SECRET_FILE_MODE);
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone (the rename landed, or it was never created).
    }
    throw err;
  }
}
