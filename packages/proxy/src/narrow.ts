import type { FilterPlan, MissionClaims } from "@missura/core";

/**
 * What NARROW had to add to the query to make the ownership check possible,
 * and therefore what has to come back out of the response:
 *   - `none`     the agent asked for all of it; nothing is ours to remove.
 *   - `relation` the whole `customer { id }` is ours.
 *   - `id`       the agent asked for the relation, we widened it with `id`.
 * A boolean could not tell the last two apart, and stripping the relation in
 * the `id` case would take away a field the agent did ask for.
 */
export type InjectedSelection = "none" | "relation" | "id";

/**
 * Response-side ownership check registered by a connector's NARROW. The
 * pipeline knows nothing about GraphQL: it looks `path` up in the parsed JSON
 * body, compares the value against `expectedCustomerId`, and removes whatever
 * NARROW added so the agent sees exactly the shape it asked for.
 *
 * SUPERSEDED by `FilterPlan`, which says the same thing for any number of
 * objects, lists included. It stays until every connector emits plans: it is
 * translated into a one-rule plan and runs through the same engine.
 */
export interface NarrowPostCheck {
  /** e.g. `["data","issue","customer","id"]`. */
  path: string[];
  expectedCustomerId: string;
  injectedSelection: InjectedSelection;
}

export interface NarrowResult {
  decision: "allow" | "deny";
  /** Rewritten request target (query qualifiers forced in, for instance). */
  path?: string;
  /** Rewritten request body (a narrowed GraphQL document/variables). */
  body?: string;
  /**
   * `github404` answers with GitHub's own not-found shape: no enumeration. It
   * also names the shape a fail-closed FILTER must take on an ALLOW, so a
   * refusal on the way back looks like the vendor's own "not found" too.
   */
  denyShape?: "github404";
  reason?: string;
  postCheck?: NarrowPostCheck;
  /**
   * What the proxy must do to the response: which objects to prove, which
   * fields to take back. Preferred over `postCheck` — it covers lists, several
   * paths, and counts.
   */
  filterPlan?: FilterPlan;
}

export type NarrowFn = (
  req: { method: string; path: string; body: string },
  claims: MissionClaims,
) => NarrowResult;

/**
 * The seam's neutral element: used until a connector installs its own NARROW,
 * and by the connection whose vendor a given mission does not narrow. It adds
 * nothing — the catalog and the mission checks still decide.
 */
export const passThroughNarrow: NarrowFn = () => ({ decision: "allow" });

/** GitHub's own not-found body, byte for byte. */
export const GITHUB_NOT_FOUND_BODY = '{"message":"Not Found"}';

/**
 * A GraphQL not-found: Linear answers 200 with an `errors` array, so an object
 * outside the mission has to look exactly like an object that does not exist.
 * A different status would itself be the leak the check exists to prevent.
 */
export const NOT_FOUND_GRAPHQL_BODY =
  '{"errors":[{"message":"issue not found"}]}';

export const OUT_OF_SCOPE_REASON = "out-of-scope object";
