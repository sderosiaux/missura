import type { FilterPlan, ParentProof } from "@missura/core";
import { decideZendesk } from "./catalog";
import { canonicalize, isVendorId, type CanonicalRequest } from "./narrow-path";
import {
  commentsPlan,
  listPlan,
  offsetPagination,
  organizationPlan,
  singlePlan,
  usesCursorPagination,
} from "./narrow-plan";
import {
  CURSOR_PAGINATION,
  deny,
  NO_ORGANIZATION_IN_SCOPE,
  NOT_IN_CATALOG_SCOPE,
  ORG_NOT_IN_MISSION,
  UNDECODABLE_PATH,
  type ZendeskNarrowResult,
} from "./narrow-result";
import { narrowSearch } from "./narrow-search";

export type { ZendeskNarrowResult } from "./narrow-result";

/**
 * The mission's Zendesk targets, resolved. Organization ids as Zendesk spells
 * them: decimal integers, as strings, because that is what a `FilterRule`
 * compares against and Zendesk publishes `organization_id` as a number.
 */
export interface ZendeskScope {
  zendeskOrganizationIds: string[];
}

/**
 * Sideloads never travel.
 *
 * `?include=users,organizations` attaches a SECOND object graph to the answer —
 * agents, groups, organizations — at paths no rule in the plan describes.
 * Proving each of them would mean a rule per sideload per route; refusing to
 * forward the parameter is one rule for all of them, and it costs the agent
 * only a call it can make directly.
 */
function withoutSideloads(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  for (const [name, value] of params) {
    if (name.toLowerCase() === "include") continue;
    next.append(name, value);
  }
  return next;
}

function query(params: URLSearchParams): string {
  const search = params.toString();
  return search.length === 0 ? "" : `?${search}`;
}

/**
 * Allows the canonical target — after showing it to the catalog again.
 *
 * Collapsing `..` is ours, not Zendesk's: the vendor would have read
 * `/api/v2/organizations/1/..%2f..%2fincremental/tickets` one way and we read
 * it as a different route. Since we forward what we decided on, that route has
 * never faced the catalog, and an uncataloged endpoint must fail closed.
 */
function allow(target: string, plan: FilterPlan): ZendeskNarrowResult {
  // The method is GET by construction: NARROW runs behind a catalog ALLOW.
  if (decideZendesk("GET", target).decision === "deny") {
    return deny(NOT_IN_CATALOG_SCOPE, "missura_operation_not_in_catalog");
  }
  return {
    decision: "allow",
    path: target,
    denyShape: "zendesk404",
    filterPlan: plan,
  };
}

/** True when the mission covers this organization id. */
function inScope(id: string, organizationIds: readonly string[]): boolean {
  return organizationIds.includes(id);
}

/**
 * A collection Zendesk itself scopes to an organization. The path names the
 * organization, so the scope is injected natively — by choosing this endpoint
 * over the account-wide one, which the catalog does not admit — and the plan
 * proves `organization_id` on every element anyway.
 */
function organizationCollection(
  canonical: CanonicalRequest,
  key: string,
  type: string,
  organizationIds: readonly string[],
): ZendeskNarrowResult {
  const id = canonical.segments[3];
  if (id === undefined || !isVendorId(id)) return deny(ORG_NOT_IN_MISSION);
  if (!inScope(id, organizationIds)) return deny(ORG_NOT_IN_MISSION);
  const params = withoutSideloads(new URLSearchParams(canonical.search));
  if (usesCursorPagination(params)) return deny(CURSOR_PAGINATION);
  return allow(
    `${canonical.path}${query(params)}`,
    listPlan(key, type, organizationIds, offsetPagination(params, key)),
  );
}

/**
 * An object named by id. Its id says nothing about an organization, so the
 * request cannot be refused before the call — it runs, and the plan proves the
 * answer. A foreign object fails the whole response closed into Zendesk's own
 * not-found, which is what a ticket that never existed answers too.
 */
function objectById(
  canonical: CanonicalRequest,
  key: string,
  type: string,
  organizationIds: readonly string[],
): ZendeskNarrowResult {
  const id = canonical.segments[3];
  if (id === undefined || !isVendorId(id)) return deny(NOT_IN_CATALOG_SCOPE);
  const params = withoutSideloads(new URLSearchParams(canonical.search));
  return allow(
    `${canonical.path}${query(params)}`,
    singlePlan(key, type, organizationIds),
  );
}

function organizations(
  canonical: CanonicalRequest,
  organizationIds: readonly string[],
): ZendeskNarrowResult {
  const [, , , id, tail] = canonical.segments;
  if (id === undefined || !isVendorId(id)) return deny(ORG_NOT_IN_MISSION);
  if (tail === "tickets") {
    return organizationCollection(
      canonical,
      "tickets",
      "ticket",
      organizationIds,
    );
  }
  if (tail === "users") {
    return organizationCollection(canonical, "users", "user", organizationIds);
  }
  if (tail !== undefined) return deny(NOT_IN_CATALOG_SCOPE);
  if (!inScope(id, organizationIds)) return deny(ORG_NOT_IN_MISSION);
  const params = withoutSideloads(new URLSearchParams(canonical.search));
  return allow(
    `${canonical.path}${query(params)}`,
    organizationPlan(organizationIds),
  );
}

/**
 * A ticket's comments: allowed, behind a proof of the ticket itself.
 *
 * VERIFIED ABSENCE is what makes the proof necessary. A comment publishes
 * `attachments, audit_id, author_id, body, created_at, html_body, id, metadata,
 * plain_body, public, type, uploads, via` — no organization and no ticket — its
 * only sideload is `include=users`, and `comments` is not a ticket sideload. No
 * single call returns the comments and the owning organization together, so
 * nothing in this answer can be judged and the plan carries no ownership rule.
 *
 * The whole decision therefore rests on `/api/v2/tickets/{id}`, which the proxy
 * fetches first and proves by its `organization_id` — the same discriminator
 * every other Zendesk object here is judged by. A ticket outside the mission, a
 * ticket that never existed and a probe that failed all refuse identically, so
 * the id in the path is not an oracle.
 *
 * The proof key names the TICKET alone, so paging through one ticket's comments
 * costs one probe and no more.
 */
function ticketProof(id: string): ParentProof {
  return {
    key: `ticket:${id}`,
    probe: { method: "GET", path: `/api/v2/tickets/${id}`, body: "" },
    ownerPath: ["ticket", "organization_id"],
  };
}

function comments(
  canonical: CanonicalRequest,
  id: string,
  organizationIds: readonly string[],
): ZendeskNarrowResult {
  const params = withoutSideloads(new URLSearchParams(canonical.search));
  if (usesCursorPagination(params)) return deny(CURSOR_PAGINATION);
  const allowed = allow(
    `${canonical.path}${query(params)}`,
    commentsPlan(offsetPagination(params, "comments")),
  );
  if (allowed.decision === "deny") return allowed;
  return {
    ...allowed,
    parentProof: ticketProof(id),
    // The proxy compares the probe's owner against these. An empty set owns
    // nothing, which is why a mission with no organization is refused above.
    missionOwnerIds: [...organizationIds],
  };
}

function tickets(
  canonical: CanonicalRequest,
  organizationIds: readonly string[],
): ZendeskNarrowResult {
  const id = canonical.segments[3];
  const tail = canonical.segments[4];
  if (tail === "comments") {
    if (id === undefined || !isVendorId(id)) return deny(NOT_IN_CATALOG_SCOPE);
    return comments(canonical, id, organizationIds);
  }
  if (tail !== undefined) return deny(NOT_IN_CATALOG_SCOPE);
  return objectById(canonical, "ticket", "ticket", organizationIds);
}

function search(
  canonical: CanonicalRequest,
  organizationIds: readonly string[],
): ZendeskNarrowResult {
  const params = withoutSideloads(new URLSearchParams(canonical.search));
  if (usesCursorPagination(params)) return deny(CURSOR_PAGINATION);
  const narrowed = narrowSearch(canonical.path, params, organizationIds);
  if (narrowed.decision === "deny" || narrowed.path === undefined) {
    return narrowed;
  }
  // Re-shown to the catalog on the rewritten target, like every other branch.
  return decideZendesk("GET", narrowed.path).decision === "deny"
    ? deny(NOT_IN_CATALOG_SCOPE, "missura_operation_not_in_catalog")
    : narrowed;
}

function decide(
  path: string,
  organizationIds: readonly string[],
): ZendeskNarrowResult {
  // A mission that resolves to no organization reaches nothing here. Not an
  // empty result set — a refusal, because "everything" is what an unscoped
  // Zendesk credential would otherwise return.
  if (organizationIds.length === 0) return deny(NO_ORGANIZATION_IN_SCOPE);

  const canonical = canonicalize(path);
  if (canonical === undefined) {
    return deny(UNDECODABLE_PATH, "missura_invalid_target");
  }
  const [api, version, resource] = canonical.segments;
  if (api !== "api" || version !== "v2") {
    return deny(NOT_IN_CATALOG_SCOPE, "missura_operation_not_in_catalog");
  }
  if (resource === "organizations")
    return organizations(canonical, organizationIds);
  if (resource === "tickets") return tickets(canonical, organizationIds);
  if (resource === "users") {
    return canonical.segments.length === 4
      ? objectById(canonical, "user", "user", organizationIds)
      : deny(NOT_IN_CATALOG_SCOPE);
  }
  if (resource === "search" && canonical.segments.length === 3) {
    return search(canonical, organizationIds);
  }
  return deny(NOT_IN_CATALOG_SCOPE, "missura_operation_not_in_catalog");
}

/**
 * Rewrites/authorizes a Zendesk REST request against the mission's organization
 * scope, or refuses it zendesk404-shaped.
 *
 * The decision is taken on the canonical request — decoded, dot-collapsed,
 * `.json` stripped — and that same canonical request is what travels. Deciding
 * on one spelling and forwarding another is how a mission for one organization
 * becomes a credentialed call to a different one.
 */
export function narrowZendesk(
  path: string,
  scope: ZendeskScope,
): ZendeskNarrowResult {
  return withScopeSize(
    decide(path, scope.zendeskOrganizationIds),
    scope.zendeskOrganizationIds.length,
  );
}

/**
 * Attached once, at the exit, so no result can be built without it. The count
 * is what the remediation is built from — "your mission covers 3 organizations"
 * reads the same whether the refused one exists or not, which is the whole
 * point (SPEC §4.8bis).
 *
 * On ALLOWs too, and not for decoration: a request the proxy lets through can
 * still be refused later, by the FILTER or by a PARENT PROOF, and that refusal
 * has to carry the same remediation as one taken here. A count attached only to
 * denials would leave the late ones speechless.
 */
function withScopeSize(
  result: ZendeskNarrowResult,
  size: number,
): ZendeskNarrowResult {
  return { ...result, missionScopeSize: size };
}
