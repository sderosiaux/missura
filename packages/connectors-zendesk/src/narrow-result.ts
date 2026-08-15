import type { DenialCode, FilterPlan, ParentProof } from "@missura/core";

/**
 * Structurally identical to the proxy's `NarrowResult`/`denyShape` — declared
 * here because a connector never imports the proxy (see
 * packages/proxy/src/narrow.ts for the seam this mirrors).
 */
export interface ZendeskNarrowResult {
  decision: "allow" | "deny";
  /** Rewritten request target (a forced `organization:` qualifier, a dropped sideload). */
  path?: string;
  /**
   * `zendesk404` answers with Zendesk's own `{"error":"RecordNotFound",
   * "description":"Not found"}`: no enumeration. On an ALLOW it names the shape
   * a fail-closed FILTER must take, so a refusal on the way back reads as the
   * vendor's own absence too.
   */
  denyShape?: "zendesk404";
  reason?: string;
  /** Which §4.8bis remediation the refusal deserves. */
  denialCode?: DenialCode;
  /** How many organizations the mission covers — the count, never the ids. */
  missionScopeSize?: number;
  /**
   * What the proxy must do to the response: which objects to prove ours, which
   * fields to take back. This is how a query we let run is made safe.
   */
  filterPlan?: FilterPlan;
  /**
   * A parent to prove before this request runs, for the one route whose objects
   * publish no owner of their own: a ticket's comments, proven through the
   * ticket named in the path.
   */
  parentProof?: ParentProof;
  /**
   * The mission's organization ids, for the stages that have no `FilterRule` to
   * read them from. Never serialized to the agent — a refusal may carry the
   * COUNT, never the members.
   */
  missionOwnerIds?: readonly string[];
}

export const ORG_NOT_IN_MISSION = "organization not in mission";
export const NO_ORGANIZATION_IN_SCOPE =
  "this mission resolves to no Zendesk organization, so nothing on this connection is in scope";
export const NOT_IN_CATALOG_SCOPE = "path not narrowable under a mission scope";
export const UNDECODABLE_PATH = "path is not decodable";
export const AMBIGUOUS_QUERY =
  "the search `query` parameter was given more than once";

/**
 * Cursor pagination is Zendesk's modern shape and the one its docs recommend,
 * but its position is computed over the UNFILTERED result set, and the
 * `FilterPlan` pagination contract has no variant for a query-string cursor —
 * so there is neither a way to walk it forward nor a handle to swap it for.
 * Saying so is worth more than a silent single page.
 */
export const CURSOR_PAGINATION =
  "cursor pagination (`page[size]`, `page[after]`, `page[before]`) is not available through missura: its position is computed over the unfiltered result set. Paginate with `page=` and `per_page=` instead";

/**
 * Every refusal is zendesk404-shaped, and every one of them says WHICH kind of
 * refusal it is — "this organization is not yours" and "no mission reaches this
 * route" need different advice, and neither is derived from the target: the
 * first counts the mission's organizations, the second describes missura's own
 * catalog.
 */
export function deny(
  reason: string,
  code: DenialCode = "missura_out_of_mission_scope",
): ZendeskNarrowResult {
  return {
    decision: "deny",
    denyShape: "zendesk404",
    reason,
    denialCode: code,
  };
}
