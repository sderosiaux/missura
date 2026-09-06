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
 * What an operation does to the world. `read` and `append` exist (M7, M8);
 * the rest are named now so a write cannot arrive later by widening one of
 * them. How a mission's `allow` claim covers an effect is `operationAllowed`.
 */
export type OperationEffect = "read" | "append" | "mutate" | "destroy" | "egress";

const WRITE_EFFECTS: ReadonlySet<string> = new Set<OperationEffect>([
  "append",
  "mutate",
  "destroy",
  "egress",
]);

/** A catalog action that changes the vendor's world, as opposed to `read`/`search`. */
export function isWriteEffect(action: string): boolean {
  return WRITE_EFFECTS.has(action);
}

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
 * THE GRANT RULE (M8). `allow` lists VERBS for the raw read path — `read`,
 * `search` — and operation NAMES for writes. A read operation runs under
 * `read`; a write runs only under its own exact name. No verb grants a write:
 * a token saying `append` grants exactly what one that does not says, so the
 * only way to a write is an operator naming the one operation they meant.
 */
export function operationAllowed(claims: MissionClaims, op: Operation): boolean {
  return op.effect === "read"
    ? claims.allow.includes("read")
    : claims.allow.includes(op.name);
}

/**
 * The pipeline's own check, on ONE request's catalog verdict. A read/search
 * action is covered by the verb, as always. A write action is covered only
 * when the request is the inner call of an operation OF THAT EFFECT that the
 * mission grants by name — never on its own, whatever the claim says, and
 * never under an operation whose effect is weaker than the route it reached.
 */
export function actionCovered(
  claims: MissionClaims,
  action: string,
  via: Operation | undefined,
): boolean {
  if (!isWriteEffect(action)) return claims.allow.includes(action);
  if (via?.effect !== action) return false;
  return operationAllowed(claims, via);
}

/**
 * What a mint may add to `allow`: catalogued writes, by exact name, once each.
 * A name the catalogue does not hold fails here — loudly, naming it — rather
 * than minting a grant that matches nothing. A read's name is refused too:
 * reads are granted by the verb, and a second spelling of the same grant is
 * one more thing an operator can get wrong.
 */
export function grantableOperations(
  names: readonly string[],
  catalogue: readonly Operation[],
): readonly string[] {
  const out: string[] = [];
  for (const name of names) {
    const op = catalogue.find((entry) => entry.name === name);
    if (op === undefined) throw new Error(`unknown operation: ${name}`);
    if (op.effect === "read") {
      throw new Error(
        `operation ${name} is a read — reads are granted by the read verb, not by name`,
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
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
      (op) => claims.connections.includes(op.connector) && operationAllowed(claims, op),
    )
    .map((op) => ({ name: op.name, effect: op.effect }));
}
