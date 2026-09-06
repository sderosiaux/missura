import { scopeSatisfies } from "./operation";
import type { ResolvedScope } from "./resolved-scope";
import type { ScopeProvenance } from "./scope-provenance";
import type { MissionScope } from "./token";

/**
 * What a mission IS on disk, apart from the store that keeps it: the input an
 * operator minted it from, and the record that describes the grant. Neither
 * holds token material — a record is a description of a grant, never a
 * bearer of it.
 */

export interface CreateMission {
  purpose: string;
  actor: string;
  scope: MissionScope;
  ttlSeconds: number;
  /**
   * Operation NAMES granted beyond the read verbs — the only way a mission
   * reaches a write (`operationAllowed`). Absent means the default grant,
   * which is read-only; present, every name is checked against the catalogue
   * this store was built with before a token exists.
   */
  allow?: readonly string[];
}

export interface MissionRecord extends CreateMission {
  id: string;
  jti: string;
  /** Epoch seconds, aligned with the token's `iat`/`exp`. */
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  /**
   * What the entity graph was asked, and what it answered — the confirmed links
   * this scope was built from, and the ones it declined to use. Absent when the
   * mint did not go through the graph at all.
   *
   * Description of a grant, like every other field here: it names ids the
   * operator already wrote down, never a token and never a credential.
   */
  resolution?: ScopeProvenance;
}

export function requireText(field: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required and must not be empty`);
  }
  return value;
}

/**
 * A connection is granted only if the RESOLVED scope proves a target for it.
 *
 * Read off the business scope instead, a mission scoped
 * `{entity: "customer:acme"}` would carry whichever connections the KEY looked
 * like it implied, which is none of them: an entity name says nothing about
 * which systems a human has confirmed for it. The mirror case is an entity
 * whose Linear link is only proposed — it carries no linear connection, because
 * there is no customer id to narrow to and so nothing to grant.
 */
export function connectionsFor(scope: ResolvedScope): string[] {
  const connections: string[] = [];
  if (scopeSatisfies(scope, "linear.customer")) connections.push("linear");
  if (scopeSatisfies(scope, "github.repo")) connections.push("github");
  if (scopeSatisfies(scope, "zendesk.organization")) connections.push("zendesk");
  return connections;
}
