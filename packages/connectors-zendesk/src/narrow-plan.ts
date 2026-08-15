import type { FilterPlan, FilterRule, PaginationRule } from "@missura/core";

/**
 * The ownership proof, and the pagination the proxy is allowed to walk.
 *
 * The discriminator is `organization_id`, published on every ticket and every
 * user Zendesk returns — nothing is injected and nothing of the agent's is
 * taken away for it, so proving ownership costs the agent no field it did not
 * already receive. An organization proves itself: its owner path is its own
 * `id`.
 *
 * Matching is `exact`. A Zendesk id is an integer, so there is no second
 * spelling of one and no reason to fold anything — a case rule that widened
 * the set of matching identifiers would be a hole, not a convenience.
 */

/** The organization discriminator, as Zendesk spells it on a ticket and a user. */
const OWNER_FIELD = "organization_id";

/**
 * Zendesk's own ceiling and default for a page: "Returns a maximum of 100
 * records per page" (developer.zendesk.com, Pagination). Reading "is there
 * more" off a page size the vendor would never honour would end the walk on
 * its first call.
 */
export const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 100;

/**
 * The vendor's own pagination positions, taken back on the way out.
 *
 * `next_page` / `previous_page` are absolute Zendesk URLs computed over the
 * UNFILTERED result set — the same objection the proxy already makes to
 * GitHub's `link` header, which it drops whenever a plan applies: following one
 * walks a list whose sizes we changed, and the URL carries the account's
 * subdomain besides. `meta` / `links` are the cursor-pagination spelling of the
 * same thing, stripped defensively even though the request that would produce
 * them is refused — a path whose leaf is absent is a no-op.
 */
const VENDOR_POSITIONS: readonly (readonly string[])[] = [
  ["next_page"],
  ["previous_page"],
  ["links"],
  ["meta"],
];

function rule(
  path: readonly string[],
  type: string,
  ownerPath: readonly string[],
  organizationIds: readonly string[],
): FilterRule {
  return {
    path,
    type,
    ownerPath,
    expectedOwnerIds: organizationIds,
    ownerMatch: "exact",
    // `organization_id` is a field Zendesk sends by default: we widened
    // nothing, so there is nothing of ours to take back.
    injected: [],
    // A foreign single object fails the whole response closed into Zendesk's
    // own not-found. Nulling `ticket` would hand a client a body its own
    // shape rejects, and Zendesk answers an absent record with a 404 anyway —
    // so out-of-scope and never-existed are the same bytes.
    nullable: false,
  };
}

/** One object, named by id in the path, proven by its own `organization_id`. */
export function singlePlan(
  key: string,
  type: string,
  organizationIds: readonly string[],
): FilterPlan {
  return {
    rules: [rule([key], type, [OWNER_FIELD], organizationIds)],
    strip: VENDOR_POSITIONS,
  };
}

/** An organization proves itself: the owner path is its own `id`. */
export function organizationPlan(
  organizationIds: readonly string[],
): FilterPlan {
  return {
    rules: [rule(["organization"], "organization", ["id"], organizationIds)],
    strip: VENDOR_POSITIONS,
  };
}

/**
 * A collection at the body root: `{"tickets":[…]}`, `{"users":[…]}`,
 * `{"results":[…]}`. Foreign elements are dropped, and the count beside the
 * list goes with them — that is the engine's rule, not this connector's.
 */
export function listPlan(
  key: string,
  type: string,
  organizationIds: readonly string[],
  pagination: PaginationRule | undefined,
): FilterPlan {
  return {
    rules: [rule([key, "*"], type, [OWNER_FIELD], organizationIds)],
    strip: VENDOR_POSITIONS,
    ...(pagination === undefined ? {} : { pagination }),
  };
}

/**
 * A comment's attachment URLs, taken back on the way out.
 *
 * `/api/v2/attachments/*` and every `attachments` segment are refused BY NAME
 * (see `catalog-refusals.ts`): a `content_url` points at a host outside this
 * connection, which missura does not proxy because it cannot filter it. A
 * comment carries those very URLs inline, so leaving them in would hand the
 * agent the second hop the catalog refuses — the refusal would hold at the
 * endpoint and leak through the body. `uploads` is the same family.
 *
 * The cost is honest and small: an agent reads a comment without being told
 * where its files live, which is exactly what the attachment refusal already
 * says it may not learn from us.
 */
const COMMENT_ATTACHMENTS: readonly (readonly string[])[] = [
  ["comments", "*", "attachments"],
  ["comments", "*", "uploads"],
];

/**
 * A ticket's comments. NO ownership rule, and that is the honest shape: a
 * comment publishes no organization and no ticket, so nothing in this response
 * can be proven. The whole decision was taken before the call, by proving the
 * ticket named in the path (`ParentProof`).
 */
export function commentsPlan(
  pagination: PaginationRule | undefined,
): FilterPlan {
  return {
    rules: [],
    strip: [...VENDOR_POSITIONS, ...COMMENT_ATTACHMENTS],
    ...(pagination === undefined ? {} : { pagination }),
  };
}

interface PageParam {
  /** The spelling the agent used, so a rewrite replaces it instead of adding one. */
  name: string;
  value: number;
}

/**
 * One positive-integer query parameter, matched case-insensitively.
 *
 * `undefined` — not a number, not positive, or given twice — means we cannot
 * say which page the agent asked for, so no pagination rule is emitted and the
 * agent gets a short page. That is the safe half of the tradeoff: a refill
 * driven by a page number we guessed wrong would re-issue the agent's query
 * against a position it never asked about.
 */
function pageParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): PageParam | undefined {
  const found = [...params].filter(([key]) => key.toLowerCase() === name);
  if (found.length === 0) return { name, value: fallback };
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(only[1])) return undefined;
  return { name: only[0], value: Number(only[1]) };
}

/**
 * How the proxy walks a Zendesk collection forward: offset pages, the only one
 * of Zendesk's two pagination styles the `FilterPlan` contract can express.
 *
 * Without it a filtered page comes back short, and a short page is a per-index
 * oracle: `per_page=1&page=N` reads back the exact interleaving of a foreign
 * organization's tickets against the mission's own, hence their count.
 */
export function offsetPagination(
  params: URLSearchParams,
  nodes: string,
): PaginationRule | undefined {
  const page = pageParam(params, "page", 1);
  const perPage = pageParam(params, "per_page", DEFAULT_PER_PAGE);
  if (page === undefined || perPage === undefined) return undefined;
  const pageSize = Math.min(perPage.value, MAX_PER_PAGE);
  return {
    path: [],
    nodes,
    requested: pageSize,
    cursor: {
      source: "query-page",
      param: page.name,
      page: page.value,
      pageSize,
    },
  };
}

/** True when the agent asked for Zendesk's cursor pagination. */
export function usesCursorPagination(params: URLSearchParams): boolean {
  return [...params].some(([name]) => name.toLowerCase().startsWith("page["));
}
