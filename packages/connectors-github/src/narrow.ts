import type { GithubRepoScope, ViaOperation } from "@missura/core";
import { decideGithub } from "./catalog";
import { canonicalize, isVendorName, type CanonicalRequest } from "./narrow-path";
import { narrowPathScoped } from "./narrow-contents";
import {
  deny,
  NOT_IN_CATALOG_SCOPE,
  REPO_NOT_IN_MISSION,
  UNDECODABLE_PATH,
  type GithubNarrowResult,
} from "./narrow-result";
import { narrowSearchIssues } from "./narrow-search";

export type { GithubNarrowResult } from "./narrow-result";

const NOT_A_REPO_NAME = "owner/repo outside GitHub's own naming charset";

/** The mission's entries for `owner/repo`, case-insensitive as GitHub resolves it. */
function entriesFor(
  owner: string,
  repo: string,
  githubRepos: readonly GithubRepoScope[],
): GithubRepoScope[] {
  const target = `${owner}/${repo}`.toLowerCase();
  return githubRepos.filter(
    (candidate) => candidate.repo.toLowerCase() === target,
  );
}

/**
 * The request behind the path: its method, and the operation it serves when
 * it is an inner call. Defaulted to a raw GET — the shape every read has —
 * so a caller that says nothing gets the read-only catalog, never the wider one.
 */
export interface GithubRequestOrigin {
  method: string;
  via?: ViaOperation;
}

const RAW_GET: GithubRequestOrigin = { method: "GET" };

/**
 * Allows the canonical target — after showing it to the catalog again, with
 * the request's OWN method and origin.
 *
 * Collapsing `..` is ours, not GitHub's: the vendor would have read
 * `/repos/o/r/contents/..%2f..%2fcollaborators` as a filename, we read it as a
 * different route. Since we forward what we decided on, that route has never
 * faced the catalog, and an uncataloged endpoint must fail closed. The method
 * travels with it because the forwarded request keeps it: a POST whose path
 * collapsed onto a GET-only route would otherwise be forwarded as a POST to a
 * route no catalog ever allowed a POST on.
 */
function allowCanonical(
  canonical: CanonicalRequest,
  origin: GithubRequestOrigin,
): GithubNarrowResult {
  const target = `${canonical.path}${canonical.search}`;
  if (decideGithub(origin.method, target, origin.via).decision === "deny") {
    return deny(NOT_IN_CATALOG_SCOPE);
  }
  return { decision: "allow", path: target };
}

/**
 * A repository the mission covers, then WHICH of it.
 *
 * A bare entry is the whole repository, exactly as before — and it wins over a
 * prefixed entry for the same repository, because an operator who wrote both
 * granted the wider of the two. Otherwise every entry carries a path prefix,
 * and only `contents` at or below one of them is served: see
 * `narrow-contents.ts` for why nothing else on that repository can be bounded.
 */
function narrowRepoPath(
  canonical: CanonicalRequest,
  githubRepos: readonly GithubRepoScope[],
  origin: GithubRequestOrigin,
): GithubNarrowResult {
  const owner = canonical.segments[1];
  const repo = canonical.segments[2];
  if (owner === undefined || repo === undefined) return deny(REPO_NOT_IN_MISSION);
  if (githubRepos.length === 0) return deny(REPO_NOT_IN_MISSION);
  if (!isVendorName(owner) || !isVendorName(repo)) return deny(NOT_A_REPO_NAME);
  const entries = entriesFor(owner, repo, githubRepos);
  if (entries.length === 0) return deny(REPO_NOT_IN_MISSION);
  if (entries.some((entry) => entry.pathPrefix === undefined)) {
    return allowCanonical(canonical, origin);
  }
  return narrowPathScoped(canonical, entries, () => allowCanonical(canonical, origin));
}

/**
 * Rewrites/authorizes a GitHub REST request against the mission's repo scope,
 * or refuses it github404-shaped. Deny by default: any catalog-allowed path
 * that isn't `/repos/{owner}/{repo}/...` or `/search/issues`, and any path at
 * all under an empty scope, is a refusal.
 *
 * The decision is taken on the canonical request — decoded, dot-collapsed — and
 * that same canonical request is what travels. Deciding on one spelling and
 * forwarding another is how a mission for one repo becomes a credentialed call
 * to a different one.
 *
 * A write (M8) is the same decision on the same path: the repository check is
 * the one check a write gets, and it happens here, before anything leaves.
 */
export function narrowGithub(
  path: string,
  scope: { githubRepos: readonly GithubRepoScope[] },
  origin: GithubRequestOrigin = RAW_GET,
): GithubNarrowResult {
  return withScopeSize(
    decide(path, scope.githubRepos, origin),
    scope.githubRepos.length,
  );
}

function decide(
  path: string,
  githubRepos: readonly GithubRepoScope[],
  origin: GithubRequestOrigin,
): GithubNarrowResult {
  const canonical = canonicalize(path);
  if (canonical === undefined) return deny(UNDECODABLE_PATH, "missura_invalid_target");
  const [first, second] = canonical.segments;

  if (first === "repos" && second !== undefined) {
    return narrowRepoPath(canonical, githubRepos, origin);
  }
  if (first === "search" && second === "issues") {
    return narrowSearchIssues(canonical, githubRepos);
  }
  return deny(NOT_IN_CATALOG_SCOPE, "missura_operation_not_in_catalog");
}

/**
 * Attached once, at the exit, so no refusal can be added without it. The count
 * is what the remediation is built from — "your mission covers 3 repositories"
 * reads the same whether the refused one exists or not, which is the whole
 * point (SPEC §4.8bis).
 */
function withScopeSize(
  result: GithubNarrowResult,
  size: number,
): GithubNarrowResult {
  return result.decision === "deny"
    ? { ...result, missionScopeSize: size }
    : result;
}
