import {
  fieldOf,
  INTROSPECT,
  remediationFor,
  tryInsteadFor,
  type Ctx,
} from "./remediation-text";
import type {
  DenialInput,
  MissionSummary,
  MissuraDenial,
} from "./remediation-types";
import type { MissionClaims, MissionScope } from "./token";

/**
 * Actionable denials (SPEC §4.8bis), assembled: the mission as the agent may be
 * told about it, plus the wording `remediation-text.ts` derives from it.
 *
 * NON-LEAK RULE, non-negotiable: everything in the block is derived from the
 * mission the agent ALREADY holds, or from the request it wrote itself. Never
 * from the denied target. "Your mission covers customer:acme — drop `team`" is
 * allowed; "ISS-12 belongs to globex" is not, because it confirms an
 * out-of-scope object exists and turns our errors into an enumeration oracle.
 * This file is where that rule is enforceable, because it is the only place
 * that chooses what a `Ctx` may hold.
 */

/**
 * The business scope, counted rather than enumerated. One rule, no case
 * analysis: no code path here can be talked into naming a target, whether it
 * came from the mission or from the request.
 */
export function scopeLabel(scope: MissionScope): string {
  const parts: string[] = [];
  if (scope.customer !== undefined && scope.customer !== "") {
    parts.push(`customer:${scope.customer}`);
  }
  if (scope.repos !== undefined && scope.repos.length > 0) {
    parts.push(`repos:${String(scope.repos.length)}`);
  }
  return parts.length === 0 ? "unscoped" : parts.join(" ");
}

export function missionSummary(
  claims: MissionClaims,
  now: number = Date.now(),
): MissionSummary {
  return {
    scope: scopeLabel(claims.scope),
    allowed_actions: [...claims.allow],
    expires_in: Math.max(0, claims.exp - Math.floor(now / 1000)),
  };
}

export function buildDenial(input: DenialInput): MissuraDenial {
  const mission =
    input.claims === undefined
      ? undefined
      : missionSummary(input.claims, input.now);
  const ctx: Ctx = {
    provider: input.provider,
    scope: mission?.scope ?? "no verified mission",
    actions: mission?.allowed_actions ?? [],
    connections: input.claims?.connections ?? [],
    scopeSize: input.scopeSize,
    requiredAction: input.requiredAction,
    field: fieldOf(input.reason),
  };
  return {
    code: input.code,
    reason: input.reason,
    ...(mission === undefined ? {} : { mission }),
    remediation: remediationFor(input.code, ctx),
    try_instead: tryInsteadFor(input.code, ctx),
    introspect: INTROSPECT,
  };
}
