import { decideGithub } from "./catalog";
import {
  canonicalize,
  DUMMY_BASE,
  isVendorName,
  type CanonicalRequest,
} from "./narrow-path";
import {
  deny,
  NOT_IN_CATALOG_SCOPE,
  REPO_NOT_IN_MISSION,
  UNDECODABLE_PATH,
  type GithubNarrowResult,
} from "./narrow-result";

export type { GithubNarrowResult } from "./narrow-result";

const NOT_A_REPO_NAME = "owner/repo outside GitHub's own naming charset";

/** `owner/repo` in scope, case-insensitive. */
function inScope(owner: string, repo: string, githubRepos: readonly string[]): boolean {
  const target = `${owner}/${repo}`.toLowerCase();
  return githubRepos.some((candidate) => candidate.toLowerCase() === target);
}

/**
 * Allows the canonical target — after showing it to the catalog again.
 *
 * Collapsing `..` is ours, not GitHub's: the vendor would have read
 * `/repos/o/r/contents/..%2f..%2fcollaborators` as a filename, we read it as a
 * different route. Since we forward what we decided on, that route has never
 * faced the catalog, and an uncataloged endpoint must fail closed.
 */
function allowCanonical(canonical: CanonicalRequest): GithubNarrowResult {
  const target = `${canonical.path}${canonical.search}`;
  // The method is GET by construction: NARROW runs behind a catalog ALLOW.
  if (decideGithub("GET", target).decision === "deny") {
    return deny(NOT_IN_CATALOG_SCOPE);
  }
  return { decision: "allow", path: target };
}

function narrowRepoPath(
  canonical: CanonicalRequest,
  githubRepos: readonly string[],
): GithubNarrowResult {
  const owner = canonical.segments[1];
  const repo = canonical.segments[2];
  if (owner === undefined || repo === undefined) return deny(REPO_NOT_IN_MISSION);
  if (githubRepos.length === 0) return deny(REPO_NOT_IN_MISSION);
  if (!isVendorName(owner) || !isVendorName(repo)) return deny(NOT_A_REPO_NAME);
  if (!inScope(owner, repo, githubRepos)) return deny(REPO_NOT_IN_MISSION);
  return allowCanonical(canonical);
}

const QUALIFIER_PREFIXES = ["repo:", "org:", "user:"];

/** True when `term` is an agent-supplied repo/org/user qualifier (case-insensitive). */
function isStrippedQualifier(term: string): boolean {
  const lowered = term.toLowerCase();
  return QUALIFIER_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function narrowSearchIssues(
  canonical: CanonicalRequest,
  githubRepos: readonly string[],
): GithubNarrowResult {
  if (githubRepos.length === 0) return deny(REPO_NOT_IN_MISSION);

  const url = new URL(`${canonical.path}${canonical.search}`, DUMMY_BASE);
  const rawQ = url.searchParams.get("q") ?? "";
  const kept = rawQ
    .split(/\s+/)
    .filter((term) => term.length > 0 && !isStrippedQualifier(term));
  const forced = githubRepos.map((repo) => `repo:${repo}`);
  url.searchParams.set("q", [...kept, ...forced].join(" "));

  return { decision: "allow", path: url.pathname + url.search };
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
 */
export function narrowGithub(
  path: string,
  scope: { githubRepos: string[] },
): GithubNarrowResult {
  const canonical = canonicalize(path);
  if (canonical === undefined) return deny(UNDECODABLE_PATH);
  const [first, second] = canonical.segments;

  if (first === "repos" && second !== undefined) {
    return narrowRepoPath(canonical, scope.githubRepos);
  }
  if (first === "search" && second === "issues") {
    return narrowSearchIssues(canonical, scope.githubRepos);
  }
  return deny(NOT_IN_CATALOG_SCOPE);
}
