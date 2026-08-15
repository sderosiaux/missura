import type { CatalogDecision } from "@missura/core";
import { refusalFor } from "./catalog-refusals";
import { canonicalize, isVendorId } from "./narrow-path";

/**
 * One allowlisted Zendesk REST route. `segments` matches the pathname shape:
 * fixed segments literal, `:id` matches exactly one segment Zendesk could be
 * spelling a resource id with (digits). `operation` mirrors the matched shape,
 * dot-joined, e.g. `organizations.tickets.list`.
 *
 * The whole surface, and no more: an organization by id, its users, its
 * tickets, a ticket and its comments by id, a user by id, and search. Every
 * one of those either NAMES an organization in its path or comes back carrying
 * `organization_id` — which is the only reason any of them is here.
 */
interface Route {
  readonly segments: readonly string[];
  readonly operation: string;
}

const ID = ":id";

const ROUTES: readonly Route[] = [
  {
    segments: ["api", "v2", "organizations", ID],
    operation: "organizations.get",
  },
  {
    segments: ["api", "v2", "organizations", ID, "tickets"],
    operation: "organizations.tickets.list",
  },
  {
    segments: ["api", "v2", "organizations", ID, "users"],
    operation: "organizations.users.list",
  },
  { segments: ["api", "v2", "tickets", ID], operation: "tickets.get" },
  {
    segments: ["api", "v2", "tickets", ID, "comments"],
    operation: "tickets.comments.list",
  },
  { segments: ["api", "v2", "users", ID], operation: "users.get" },
  { segments: ["api", "v2", "search"], operation: "search.list" },
];

function matches(route: Route, segments: readonly string[]): boolean {
  if (segments.length !== route.segments.length) return false;
  return route.segments.every((expected, i) => {
    const actual = segments[i];
    if (actual === undefined) return false;
    return expected === ID ? isVendorId(actual) : expected === actual;
  });
}

function deny(reason: string, operation = "unknown"): CatalogDecision {
  return { decision: "deny", operation, action: "unknown", reason };
}

/**
 * Decide whether a raw Zendesk REST request may reach the vendor. Deny by
 * default: only `GET` requests matching an allowlisted route shape pass.
 *
 * Refusals are consulted BEFORE the allowlist, not after. `/api/v2/users/me`
 * and `/api/v2/organizations/show_many` both have the SHAPE of an allowed
 * route, and the digit-only id already refuses them — but a generic "not in the
 * catalog" would hide that they were refused on purpose, and the decision log
 * is where that difference has to survive.
 */
export function decideZendesk(method: string, path: string): CatalogDecision {
  if (method !== "GET") {
    return deny(
      `method ${method} is not allowed — the Zendesk catalog is read-only (GET only)`,
    );
  }

  const canonical = canonicalize(path);
  if (canonical === undefined) {
    return deny("the request path is not decodable, so no route was decided");
  }
  const { segments } = canonical;

  const refusal = refusalFor(segments);
  if (refusal !== undefined) return deny(refusal.reason, refusal.operation);

  const route = ROUTES.find((candidate) => matches(candidate, segments));
  if (route === undefined) {
    return deny(
      `path /${segments.join("/")} is not in the Zendesk read catalog`,
    );
  }

  return {
    decision: "allow",
    operation: route.operation,
    action: "read",
    reason: `read request matching allowlisted route: ${route.operation}`,
  };
}
