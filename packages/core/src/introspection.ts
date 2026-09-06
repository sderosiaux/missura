import {
  operationsFor,
  type Operation,
  type OperationListing,
} from "./operation";
import { missionSummary } from "./remediation";
import type { MissionClaims, MissionDegradation } from "./token";

/**
 * What a mission tells the agent holding it (SPEC §4.8, RFC 7662 in spirit):
 * its own grant, and the systems that grant does NOT reach, by reason class.
 *
 * Same non-leak rule as `remediation.ts`, for the same reason: everything here
 * derives from the claims the agent already holds, nothing from outside them.
 * The mission record knows more — the confirmed ids the scope was built from,
 * the id behind each degradation — and none of it is consulted, so none of it
 * can be answered.
 */
export interface MissionIntrospection {
  /** The entity's whole key, when the mission is scoped to one. */
  entity?: string;
  purpose: string;
  actor: string;
  /** Seconds left, floored at 0. */
  expires_in: number;
  allow: readonly string[];
  /** The connections IN the mission. Every other listener refuses it. */
  systems: readonly string[];
  /**
   * The systems the graph knew about and left OUT, with the class of reason.
   * For `no_entity` and `ambiguous_entity` the system named is the one the
   * mission's native id belongs to — that id is in scope, and the entry says
   * nothing else was added through it.
   */
  degraded: readonly MissionDegradation[];
  /**
   * The operations this mission may run (`POST /missura/op/<name>`): connector
   * in the mission, effect covered by `allow`. Nothing about the others.
   */
  operations: readonly OperationListing[];
}

export function missionIntrospection(
  claims: MissionClaims,
  now: number,
  catalogue: readonly Operation[],
): MissionIntrospection {
  const entity = claims.scope.entity;
  return {
    ...(entity === undefined || entity === "" ? {} : { entity }),
    purpose: claims.purpose,
    actor: claims.actor,
    expires_in: missionSummary(claims, now).expires_in,
    allow: [...claims.allow],
    systems: [...claims.connections],
    // Field by field: a claims object reaches this from a token, and nothing
    // that happened to ride on a degradation there rides out.
    degraded: claims.degraded.map((d) => ({ system: d.system, reason: d.reason })),
    operations: operationsFor(claims, catalogue),
  };
}
