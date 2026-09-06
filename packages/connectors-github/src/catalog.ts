import type { CatalogDecision, ViaOperation } from "@missura/core";

/**
 * One allowlisted GitHub REST route. `pattern` matches the pathname against
 * the segment shape (fixed segments literal, `:param` matches exactly one
 * segment, `:rest*` matches one-or-more trailing segments). `operation`
 * mirrors the matched shape, dot-joined, e.g. `repos.issues.list`.
 */
interface Route {
  readonly method: "GET" | "POST" | "DELETE";
  readonly segments: readonly string[];
  readonly operation: string;
  readonly action: "read" | "append" | "destroy";
}

const PARAM = ":param";
const REST = ":rest*";

/** The raw catalog: what an agent's own request may reach. Reads, and only reads. */
const ROUTES: readonly Route[] = [
  { method: "GET", segments: ["repos", PARAM, PARAM], operation: "repos.get", action: "read" },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "issues"],
    operation: "repos.issues.list",
    action: "read",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "issues", PARAM],
    operation: "repos.issues.get",
    action: "read",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "issues", PARAM, "comments"],
    operation: "repos.issues.comments.list",
    action: "read",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "pulls"],
    operation: "repos.pulls.list",
    action: "read",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "pulls", PARAM],
    operation: "repos.pulls.get",
    action: "read",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "contents"],
    operation: "repos.contents.get",
    action: "read",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "contents", REST],
    operation: "repos.contents.get",
    action: "read",
  },
  { method: "GET", segments: ["search", "issues"], operation: "search.issues", action: "read" },
];

/**
 * THE WRITE ROUTES (M8), reachable ONLY as the inner call of an operation.
 * The executor is the one caller that sets `via`, in-process; the listener
 * never does, so a raw request — whatever it sends — is decided against
 * `ROUTES` alone and a POST stays refused exactly as it always was. One route
 * per write operation: the write an operation plans is the only write that
 * exists, and nothing here widens with the method. The action names what the
 * route costs — `destroy` is the one a human must approve (M10) — and the
 * pipeline refuses an inner call whose operation is of a weaker effect.
 */
const WRITE_ROUTES: readonly Route[] = [
  {
    method: "POST",
    segments: ["repos", PARAM, PARAM, "issues", PARAM, "comments"],
    operation: "repos.issues.comments.create",
    action: "append",
  },
  {
    method: "DELETE",
    segments: ["repos", PARAM, PARAM, "issues", "comments", PARAM],
    operation: "repos.issues.comments.delete",
    action: "destroy",
  },
];

/** Dummy base so `URL` can strip query strings and normalize the path safely. */
const DUMMY_BASE = "https://vendor.invalid";

function pathSegments(path: string): string[] {
  const { pathname } = new URL(path, DUMMY_BASE);
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function matches(route: Route, segments: readonly string[]): boolean {
  const last = route.segments[route.segments.length - 1];
  if (last === REST) {
    const fixed = route.segments.slice(0, -1);
    if (segments.length <= fixed.length) return false;
    return fixed.every((expected, i) => expected === PARAM || expected === segments[i]);
  }
  if (segments.length !== route.segments.length) return false;
  return route.segments.every((expected, i) => expected === PARAM || expected === segments[i]);
}

function deny(reason: string): CatalogDecision {
  return { decision: "deny", operation: "unknown", action: "unknown", reason };
}

/**
 * Decide whether a GitHub REST request may reach the vendor. Deny by default:
 * only requests matching an allowlisted route shape pass, and every denial
 * names the exact method/path that was refused. Off the wire that is `GET`
 * and nothing else; under an operation (`via`), the one write it plans too.
 */
export function decideGithub(
  method: string,
  path: string,
  via?: ViaOperation,
): CatalogDecision {
  const routes = via === undefined ? ROUTES : [...ROUTES, ...WRITE_ROUTES];
  if (!routes.some((route) => route.method === method)) {
    return deny(
      `method ${method} is not allowed — the raw catalog is read-only (GET only); writes run only as operations`,
    );
  }

  const segments = pathSegments(path);
  const route = routes.find(
    (candidate) => candidate.method === method && matches(candidate, segments),
  );
  if (route === undefined) {
    return deny(`${method} /${segments.join("/")} is not in the GitHub catalog`);
  }

  return {
    decision: "allow",
    operation: route.operation,
    action: route.action,
    reason: `${route.action} request matching allowlisted route: ${route.operation}`,
  };
}
