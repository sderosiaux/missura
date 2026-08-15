import type { FilterPlan } from "@missura/core";
import { listPlan, offsetPagination } from "./narrow-plan";
import {
  AMBIGUOUS_QUERY,
  deny,
  type ZendeskNarrowResult,
} from "./narrow-result";

/**
 * `GET /api/v2/search`, narrowed by the one qualifier Zendesk actually has.
 *
 * WHAT IS REAL, checked against the published Zendesk Support search reference:
 * the qualifier is `organization:`, and it takes a NAME OR A NUMERIC ID —
 * `organization:customers` and `organization:22989442` are both given as
 * examples, for `type:ticket` and for `type:user`. `organization_id:` appears
 * nowhere in that reference: it is not a qualifier, and a query carrying one
 * would be read as free text. Missura strips it anyway, because an agent that
 * wrote it meant to scope and should not silently get a full-text search
 * instead.
 *
 * WHAT IS ADVISORY: on tickets, `organization:` is documented as returning
 * "tickets by requesters who are members of the organization" — which is NOT
 * the same predicate as `ticket.organization_id`. A requester who belongs to
 * two organizations can raise a ticket recorded against one of them and still
 * match the other. So the qualifier is a native NARROWING, cheaper than
 * filtering and lighter on the vendor, and it is never the control: the
 * `FilterPlan` proves `organization_id` on every result that comes back, and
 * that is what makes the answer safe.
 *
 * Multiple organizations are appended as repeated qualifiers, which the
 * reference says is how one property keyword ORs with itself. If that reading
 * is wrong the query only matches FEWER objects than the mission covers — it
 * costs recall, never isolation, because the filter is what decides.
 */

/** Qualifiers an agent might use to widen or re-aim the organization scope. */
const STRIPPED_PREFIXES = ["organization:", "organization_id:"];

/**
 * A term whose meaning depends on Zendesk's search grammar rather than on plain
 * conjunction: search ANDs terms by default, but a quote binds a phrase and,
 * once a qualifier is lifted out of one, can be left dangling. Rewriting a
 * grammar we do not parse is the mistake; the filter covers both branches.
 */
function usesGrammar(term: string): boolean {
  const lowered = term.toLowerCase();
  if (lowered === "or" || lowered === "and" || lowered === "not") return true;
  return /["()]/.test(term);
}

function isStrippedQualifier(term: string): boolean {
  const lowered = term.toLowerCase();
  return STRIPPED_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/**
 * One rule over the whole result page, holding EVERY mission organization at
 * once: a result is ours when its `organization_id` is any of them, which a
 * per-organization rule could not say — each would drop what the others keep.
 *
 * A search may answer with organizations and groups as well as tickets and
 * users, and neither of those publishes an `organization_id`. Their owner does
 * not resolve, so they are foreign and get dropped. That is the fail-closed
 * direction and it is deliberate: `type:organization` is served by
 * `/api/v2/organizations/{id}`, where the object proves itself.
 */
function searchPlan(
  organizationIds: readonly string[],
  params: URLSearchParams,
): FilterPlan {
  return listPlan(
    "results",
    "search-result",
    organizationIds,
    offsetPagination(params, "results"),
  );
}

/**
 * Rewrites the query so the mission's organizations are forced in, dropping any
 * the agent supplied. The rest of the query — `type:`, `status:`, free text,
 * sort order — is the agent's and travels untouched.
 */
export function narrowSearch(
  path: string,
  params: URLSearchParams,
  organizationIds: readonly string[],
): ZendeskNarrowResult {
  const queries = [...params].filter(
    ([name]) => name.toLowerCase() === "query",
  );
  if (queries.length > 1) return deny(AMBIGUOUS_QUERY);

  const allow = (search: string): ZendeskNarrowResult => ({
    decision: "allow",
    path: `${path}${search}`,
    // Names the shape a fail-closed FILTER must take on the way back:
    // Zendesk's own not-found, so a refusal is indistinguishable from absence.
    denyShape: "zendesk404",
    filterPlan: searchPlan(organizationIds, params),
  });

  const raw = queries[0]?.[1] ?? "";
  const kept = raw
    .split(/\s+/)
    .filter((term) => term.length > 0 && !isStrippedQualifier(term));
  if (kept.some(usesGrammar)) {
    // Removing a term from an expression we do not parse changes it in ways we
    // cannot predict, so the query travels exactly as the agent wrote it and
    // the filter is the only control on this branch.
    return allow(`?${params.toString()}`);
  }

  const next = new URLSearchParams();
  for (const [name, value] of params) {
    if (name.toLowerCase() === "query") continue;
    next.append(name, value);
  }
  const forced = organizationIds.map((id) => `organization:${id}`);
  next.set("query", [...kept, ...forced].join(" "));
  return allow(`?${next.toString()}`);
}
