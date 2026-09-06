import type { CatalogDecision, ViaOperation } from "@missura/core";
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

/**
 * THE WRITE ROUTE (M10), reachable ONLY as the inner call of an operation:
 * a ticket update, which is how a reply is posted. `egress` because a
 * public comment emails the requester — the write stays in the mission's
 * organization, its destination does not, so a human approves it. `via` is
 * set in-process by the executor and never by the listener, so off the wire
 * this catalog is GET only, exactly as before.
 */
interface WriteRoute extends Route {
  readonly method: "PUT";
  readonly action: "egress";
}

const WRITE_ROUTES: readonly WriteRoute[] = [
  {
    method: "PUT",
    segments: ["api", "v2", "tickets", ID],
    operation: "tickets.update",
    action: "egress",
  },
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
export function decideZendesk(
  method: string,
  path: string,
  via?: ViaOperation,
): CatalogDecision {
  const write = via === undefined ? undefined : WRITE_ROUTES.find((r) => r.method === method);
  if (method !== "GET" && write === undefined) {
    return deny(
      `method ${method} is not allowed — the Zendesk catalog is read-only (GET only); writes run only as operations`,
    );
  }

  const canonical = canonicalize(path);
  if (canonical === undefined) {
    return deny("the request path is not decodable, so no route was decided");
  }
  const { segments } = canonical;

  // The refused families are refused under an operation too: a write on
  // `update_many` is a bulk endpoint before it is a write.
  const refusal = refusalFor(segments);
  if (refusal !== undefined) return deny(refusal.reason, refusal.operation);

  if (write !== undefined) {
    if (!matches(write, segments)) {
      return deny(`${method} /${segments.join("/")} is not in the Zendesk catalog`);
    }
    return {
      decision: "allow",
      operation: write.operation,
      action: write.action,
      reason: `${write.action} request matching allowlisted route: ${write.operation}`,
    };
  }

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
