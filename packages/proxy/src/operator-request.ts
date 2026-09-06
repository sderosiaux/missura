import { assertEntityKey, MAX_TTL_SECONDS } from "@missura/core";
import type { CreateMission, MissionScope } from "@missura/core";

/**
 * Reading an operator's request, and refusing it by name. Nothing here talks
 * to the store or to the network: it turns a JSON body into a `CreateMission`
 * or into a `FieldError` that says which field was wrong — never why the
 * mission would have been refused later.
 */

/** A validation failure that names the field the operator got wrong. */
export class FieldError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(reason);
    this.field = field;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) throw new FieldError("body", "request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FieldError("body", "request body is not valid JSON");
  }
  if (!isRecord(parsed))
    throw new FieldError("body", "request body must be a JSON object");
  return parsed;
}

function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FieldError(field, `${field} must be a non-empty string`);
  }
  return value;
}

/**
 * The entity key's own shape, refused as a NAMED field rather than as a 500:
 * `assertEntityKey` is the one rule, and the operator plane owes its caller the
 * field it got wrong — not an opaque internal error.
 */
function readEntityKey(value: string): string {
  try {
    return assertEntityKey(value);
  } catch (err) {
    throw new FieldError(
      "scope",
      err instanceof Error ? err.message : "scope.entity is not an entity key",
    );
  }
}

function readScope(value: unknown): MissionScope {
  if (!isRecord(value))
    throw new FieldError("scope", "scope must be an object");
  const scope: MissionScope = {};
  if (value.entity !== undefined) {
    scope.entity = readEntityKey(requireText("scope", value.entity));
  }
  if (value.repos !== undefined) {
    if (
      !Array.isArray(value.repos) ||
      value.repos.some((repo) => typeof repo !== "string")
    ) {
      throw new FieldError("scope", "scope.repos must be an array of strings");
    }
    scope.repos = value.repos as string[];
  }
  // Deny by default: a mission with no target is a scope-all mission.
  if (scope.entity === undefined && (scope.repos ?? []).length === 0) {
    throw new FieldError("scope", "scope must name an entity or repos");
  }
  return scope;
}

/**
 * The operation names to grant on top of the read verbs (M8). Shape only —
 * whether each name exists is the store's question, against its catalogue —
 * and absent means the default, read-only grant.
 */
function readAllow(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new FieldError("allow", "allow must be an array of operation names");
  }
  return value as string[];
}

function readTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new FieldError("ttl", "ttl must be a positive integer of seconds");
  }
  // The cap is enforced again at minting time (core); refusing it here is what
  // turns it into a named field error instead of an opaque 500.
  if (value > MAX_TTL_SECONDS) {
    throw new FieldError(
      "ttl",
      `ttl must not exceed ${String(MAX_TTL_SECONDS)} seconds`,
    );
  }
  return value;
}

/**
 * RFC 9396-shaped mission request. The details entry is the grant: anything
 * that is not a single `type: "mission"` entry is refused rather than
 * interpreted — an operator plane guesses at nothing.
 */
export function readMissionRequest(
  body: Record<string, unknown>,
): CreateMission {
  if (body.grant_type !== "client_credentials") {
    throw new FieldError("grant_type", "grant_type must be client_credentials");
  }
  const details = body.authorization_details;
  if (!Array.isArray(details) || details.length !== 1) {
    throw new FieldError(
      "authorization_details",
      "authorization_details must hold exactly one mission entry",
    );
  }
  const entry: unknown = details[0];
  if (!isRecord(entry) || entry.type !== "mission") {
    throw new FieldError(
      "authorization_details",
      'authorization_details[0].type must be "mission"',
    );
  }
  const allow = readAllow(entry.allow);
  return {
    purpose: requireText("purpose", entry.purpose),
    actor: requireText("actor", entry.actor),
    scope: readScope(entry.scope),
    ttlSeconds: readTtl(entry.ttl),
    ...(allow === undefined ? {} : { allow }),
  };
}
