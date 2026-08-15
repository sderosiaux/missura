import type { DenialCode, FilterPlan, MissionClaims } from "@missura/core";

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
 * objects, lists included. NO shipped connector emits one any more — Linear was
 * the last, and moved to plans with the type-driven walk. It is translated into
 * a one-rule plan and runs through the same engine, and it exists now only so a
 * connector under construction has a one-object shortcut; deleting it is a
 * standalone change, not part of a behaviour one.
 */
export interface NarrowPostCheck {
  /** e.g. `["data","issue","customer","id"]`. */
  path: string[];
  expectedCustomerId: string;
  injectedSelection: InjectedSelection;
}

/**
 * The vendor absences a connector may ask a refusal to imitate. One member per
 * REST connection, because each vendor spells absence its own way and a client
 * that cannot parse a refusal never acts on it.
 */
export type DenyShape = "github404" | "zendesk404";

export interface NarrowResult {
  decision: "allow" | "deny";
  /** Rewritten request target (query qualifiers forced in, for instance). */
  path?: string;
  /** Rewritten request body (a narrowed GraphQL document/variables). */
  body?: string;
  /**
   * Which vendor's own "not found" a refusal wears: no enumeration. It also
   * names the shape a fail-closed FILTER must take on an ALLOW, so a refusal on
   * the way back looks like the vendor's own absence too.
   */
  denyShape?: DenyShape;
  reason?: string;
  /**
   * Which §4.8bis remediation the refusal deserves. Absent ⇒ "out of mission
   * scope", the safe default: it is derived from the mission alone, so a
   * connector that says nothing cannot accidentally produce a remediation that
   * describes the target.
   */
  denialCode?: DenialCode;
  /**
   * How many targets the mission resolves to in this connector's terms — the
   * COUNT only. "Your mission covers 3 repositories" is a fact about the
   * agent's own grant and reads identically whether the refused repo exists or
   * not; naming any of them would not.
   */
  missionScopeSize?: number;
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

/** GitHub's own not-found message, byte for byte. */
export const GITHUB_NOT_FOUND_MESSAGE = "Not Found";

/**
 * GitHub's own not-found body, byte for byte.
 *
 * Used where a refusal must carry NOTHING else: on the way back, when the
 * vendor already answered and the filter proved the object foreign. A missura
 * block there would be the enumeration oracle itself — an object that never
 * existed gets the vendor's bare 404, so an object that exists out of scope
 * must get exactly the same bytes. Request-side refusals are decided before
 * the vendor is asked, so they carry the block (see `deny.ts`).
 */
export const GITHUB_NOT_FOUND_BODY = `{"message":"${GITHUB_NOT_FOUND_MESSAGE}"}`;

/**
 * Zendesk's own not-found, byte for byte, verified against the published
 * reference (developer.zendesk.com, Users API): `{"error":"RecordNotFound",
 * "description":"Not found"}`. Same role as the GitHub pair — the bare body is
 * what a refusal decided AFTER the vendor answered carries, so an object that
 * exists out of scope and one that never existed are the same bytes.
 */
export const ZENDESK_NOT_FOUND_MESSAGE = "Not found";
export const ZENDESK_NOT_FOUND_BODY = `{"error":"RecordNotFound","description":"${ZENDESK_NOT_FOUND_MESSAGE}"}`;

/**
 * The vendor's own absence, per shape. Kept as one table so the request side
 * (which pins the top-level message) and the response side (which returns the
 * whole body) cannot drift into two different "not found"s for one vendor.
 */
const NOT_FOUND: Record<DenyShape, { message: string; body: string }> = {
  github404: { message: GITHUB_NOT_FOUND_MESSAGE, body: GITHUB_NOT_FOUND_BODY },
  zendesk404: {
    message: ZENDESK_NOT_FOUND_MESSAGE,
    body: ZENDESK_NOT_FOUND_BODY,
  },
};

/**
 * The vendor message a request-side refusal must pin, or `undefined` when the
 * connector named no shape — which is what keeps a refusal at 403 rather than
 * borrowing a 404 nobody asked for.
 */
export function notFoundMessage(shape: DenyShape | undefined): string | undefined {
  return shape === undefined ? undefined : NOT_FOUND[shape].message;
}

/** The body a fail-closed FILTER answers with, in the vendor's own envelope. */
export function notFoundBody(shape: DenyShape | undefined): string {
  return shape === undefined ? NOT_FOUND_GRAPHQL_BODY : NOT_FOUND[shape].body;
}

/**
 * The GraphQL fail-closed body: what an agent gets when the vendor answered and
 * the filter proved the object foreign. 200 with an `errors` array, because
 * that is the envelope a GraphQL SDK can parse.
 *
 * KNOWN LIMITATION, not a property (SPEC §7, M3). These are NOT the bytes
 * Linear sends for an id that does not exist, so an out-of-scope object is
 * distinguishable from one that never existed. It is not synthesized to match
 * because the vendor's real absence body could not be established with
 * evidence. Four independent gaps, none of them a matter of effort:
 *   - `@linear/sdk@90` declares every field of a GraphQL error optional and
 *     pins no `extensions` content; its `LinearErrorType` enum has no not-found
 *     member at all, and the `extensions.type` reported outside the SDK
 *     contradicts that enum. Two sources, no primary artefact;
 *   - the pinned schema cannot arbitrate. It is extracted from the SDK's MODEL
 *     types (`@linear/sdk/dist/index.d.mts`, 41 types) and carries no `Query`
 *     root, so it does not even say whether `issue` is nullable — i.e. whether
 *     absence reads `{"data":{"issue":null}}` or `{"data":null}`;
 *   - no schema could supply the rest anyway: GraphQL schemas describe data,
 *     never error payloads. Only a RECORDED live response can, which is the
 *     compatibility suite's job (PRD §33, milestone M4);
 *   - and the real body's `errors[].path` follows the agent's own field ALIAS
 *     while its `data` mirrors the agent's selection — neither is knowable from
 *     a per-plan constant.
 * Guessing bytes here would trade a visible limitation for an invisible one.
 */
export const NOT_FOUND_GRAPHQL_BODY =
  '{"errors":[{"message":"issue not found"}]}';

export const OUT_OF_SCOPE_REASON = "out-of-scope object";
