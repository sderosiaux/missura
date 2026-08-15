import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Missions and their revocations, persisted as plain JSON (mode 0600). The file
 * holds no token material: a record is a description of a grant, never a
 * bearer of it, so leaking the state file leaks no capability.
 *
 * Every mutation writes synchronously — a revoke that survives only in memory
 * would be a revoke that a crash silently undoes.
 */
export class MissionStore {
  private readonly stateFile: string;
  private readonly signingKey: Buffer;
  private records: MissionRecord[];

  constructor(stateFile: string, signingKey: Buffer) {
    this.stateFile = stateFile;
    this.signingKey = signingKey;
    this.records = existsSync(stateFile)
      ? parseState(readFileSync(stateFile, "utf8"))
      : [];
  }

  create(input: CreateMission): { record: MissionRecord; token: string } {
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
    const record = this.records.find(
      (m) => m.id === idOrJti || m.jti === idOrJti,
    );
    if (!record) throw new Error(`unknown mission: ${idOrJti}`);
    // Idempotent (RFC 7009 semantics): a second revoke must not move the clock.
    if (record.revokedAt === undefined) {
      record.revokedAt = Math.floor(Date.now() / 1000);
      this.persist();
    }
    return record;
  }

  isRevoked(jti: string): boolean {
    const record = this.records.find((m) => m.jti === jti);
    return record?.revokedAt !== undefined;
  }

  /** Non-expired, non-revoked missions, in creation order. */
  active(now: number = Date.now()): MissionRecord[] {
    const seconds = Math.floor(now / 1000);
    return this.records.filter(
      (m) => m.revokedAt === undefined && m.expiresAt > seconds,
    );
  }

  private persist(): void {
    const state: StateFile = { missions: this.records };
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.stateFile, JSON.stringify(state), {
      mode: SECRET_FILE_MODE,
    });
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
