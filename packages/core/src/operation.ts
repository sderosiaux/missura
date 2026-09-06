import type { LinkSystem } from "./entity-graph";
import type { ResolvedScope } from "./resolved-scope";
import type { MissionClaims } from "./token";

/**
 * AN OPERATION: a named, deterministic thing missura can do FOR the agent,
 * under the agent's own mission (M7).
 *
 * It is not a bypass. An operation is a plan of vendor requests, and every one
 * of them is handed to the same pipeline a raw agent request goes through —
 * same catalog, same NARROW, same FILTER, same refusals, same log. The plan
 * chooses WHICH target of the mission to ask about; it never decides whether
 * the mission may. That decision stays where it always was, so an operation
 * cannot reach one object a raw call could not.
 */

/**
 * What an operation does to the world. Only `read` exists in M7; the rest are
 * named now so a write cannot arrive later by widening `read`. A mission's
 * `allow` claim covers an operation when it lists its effect.
 */
export type OperationEffect = "read" | "append" | "mutate" | "destroy" | "egress";

/**
 * What an operation needs from the mission to run at all, in the terms the
 * entity graph already resolves — one per system, matching `ResolvedScope`
 * field for field. This is what a later gap report will be computed from:
 * "you would need a confirmed Zendesk organization for that" is a fact about
 * the need, never about the target.
 */
export type OperationNeed =
  | "linear.customer"
  | "github.repo"
  | "zendesk.organization";

/** One inner vendor request, exactly as an agent would have sent it. */
export interface OperationStep {
  method: string;
  path: string;
  body: string;
}

export interface Operation {
  /** Connector-prefixed and stable: `zendesk.tickets.for_entity`. */
  name: string;
  /**
   * One connector per operation in M7. The executor is step-based, so an
   * operation spanning two connectors is a later addition, not a rewrite.
   */
  connector: LinkSystem;
  effect: OperationEffect;
  needs: OperationNeed;
  /**
   * The vendor requests this operation costs, for a mission resolved to
   * `scope`. Targets come from the scope and from nowhere else; parameters are
   * the agent's own (an empty object when it sent none).
   */
  plan(
    scope: ResolvedScope,
    params: Readonly<Record<string, unknown>>,
  ): readonly OperationStep[];
}

/** What introspection tells the agent about one operation it may run. */
export type OperationListing = Pick<Operation, "name" | "effect">;

/**
 * Whether the resolved scope holds what the need names. Absent and empty read
 * the same — nothing — because "no target" must never mean "every target".
 */
export function scopeSatisfies(
  scope: ResolvedScope,
  need: OperationNeed,
): boolean {
  switch (need) {
    case "linear.customer":
      return (
        scope.linearCustomerId !== undefined && scope.linearCustomerId !== ""
      );
    case "github.repo":
      return scope.githubRepos.length > 0;
    case "zendesk.organization":
      return (scope.zendeskOrganizationIds ?? []).length > 0;
  }
}

/**
 * The operations THIS mission may run, from the claims alone: connector in
 * the mission, effect covered by `allow`. Anything else is absent rather than
 * marked unavailable — a listing that named an operation on a degraded system
 * would name the system, which is the introspection answer's job, by reason.
 */
export function operationsFor(
  claims: MissionClaims,
  catalogue: readonly Operation[],
): OperationListing[] {
  return catalogue
    .filter(
      (op) =>
        claims.connections.includes(op.connector) &&
        claims.allow.includes(op.effect),
    )
    .map((op) => ({ name: op.name, effect: op.effect }));
}
