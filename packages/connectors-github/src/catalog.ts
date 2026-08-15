import type { CatalogDecision } from "@missura/core";

/**
 * One allowlisted GitHub REST route. `pattern` matches the pathname against
 * the segment shape (fixed segments literal, `:param` matches exactly one
 * segment, `:rest*` matches one-or-more trailing segments). `operation`
 * mirrors the matched shape, dot-joined, e.g. `repos.issues.list`.
 */
interface Route {
  readonly method: "GET";
  readonly segments: readonly string[];
  readonly operation: string;
}

const PARAM = ":param";
const REST = ":rest*";

const ROUTES: readonly Route[] = [
  { method: "GET", segments: ["repos", PARAM, PARAM], operation: "repos.get" },
  { method: "GET", segments: ["repos", PARAM, PARAM, "issues"], operation: "repos.issues.list" },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "issues", PARAM],
    operation: "repos.issues.get",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "issues", PARAM, "comments"],
    operation: "repos.issues.comments.list",
  },
  { method: "GET", segments: ["repos", PARAM, PARAM, "pulls"], operation: "repos.pulls.list" },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "pulls", PARAM],
    operation: "repos.pulls.get",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "contents"],
    operation: "repos.contents.get",
  },
  {
    method: "GET",
    segments: ["repos", PARAM, PARAM, "contents", REST],
    operation: "repos.contents.get",
  },
  { method: "GET", segments: ["search", "issues"], operation: "search.issues" },
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
 * Decide whether a raw GitHub REST request may reach the vendor. Deny by
 * default: only `GET` requests matching an allowlisted route shape pass, and
 * every denial names the exact method/path that was refused.
 */
export function decideGithub(method: string, path: string): CatalogDecision {
  if (method !== "GET") {
    return deny(`method ${method} is not allowed — the M1 catalog is read-only (GET only)`);
  }

  const segments = pathSegments(path);
  const route = ROUTES.find((candidate) => matches(candidate, segments));
  if (route === undefined) {
    return deny(`path /${segments.join("/")} is not in the GitHub read catalog`);
  }

  return {
    decision: "allow",
    operation: route.operation,
    action: "read",
    reason: `read request matching allowlisted route: ${route.operation}`,
  };
}
