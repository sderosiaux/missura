import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { SECRET_FILE_MODE } from "./keys";
import type { MissionRecord } from "./missions";

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
