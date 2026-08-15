/**
 * Structurally identical to the proxy's `NarrowResult`/`denyShape` — declared
 * here because a connector never imports the proxy (see packages/proxy/src/narrow.ts
 * for the seam this mirrors).
 */
export interface GithubNarrowResult {
  decision: "allow" | "deny";
  /** Rewritten request target (forced `repo:` qualifiers, for instance). */
  path?: string;
  /** `github404` answers with GitHub's own not-found shape: no enumeration. */
  denyShape?: "github404";
  reason?: string;
}

const REPO_NOT_IN_MISSION = "repo not in mission";
const NOT_IN_CATALOG_SCOPE = "path not narrowable under a mission scope";

/** Dummy base so `URL` can parse pathname + query safely. */
const DUMMY_BASE = "https://vendor.invalid";

function deny(reason: string): GithubNarrowResult {
  return { decision: "deny", denyShape: "github404", reason };
}

function pathSegments(path: string): string[] {
  const { pathname } = new URL(path, DUMMY_BASE);
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/** `owner/repo` in scope, case-insensitive. */
function inScope(owner: string, repo: string, githubRepos: readonly string[]): boolean {
  const target = `${owner}/${repo}`.toLowerCase();
  return githubRepos.some((candidate) => candidate.toLowerCase() === target);
}

const QUALIFIER_PREFIXES = ["repo:", "org:", "user:"];

/** True when `term` is an agent-supplied repo/org/user qualifier (case-insensitive). */
function isStrippedQualifier(term: string): boolean {
  const lowered = term.toLowerCase();
  return QUALIFIER_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function narrowSearchIssues(
  path: string,
  githubRepos: readonly string[],
): GithubNarrowResult {
  if (githubRepos.length === 0) return deny(REPO_NOT_IN_MISSION);

  const url = new URL(path, DUMMY_BASE);
  const rawQ = url.searchParams.get("q") ?? "";
  const kept = rawQ
    .split(/\s+/)
    .filter((term) => term.length > 0 && !isStrippedQualifier(term));
  const forced = githubRepos.map((repo) => `repo:${repo}`);
  const nextQ = [...kept, ...forced].join(" ");
  url.searchParams.set("q", nextQ);

  return { decision: "allow", path: url.pathname + url.search };
}

function narrowRepoPath(
  segments: readonly string[],
  githubRepos: readonly string[],
  path: string,
): GithubNarrowResult {
  const owner = segments[1];
  const repo = segments[2];
  if (owner === undefined || repo === undefined) return deny(REPO_NOT_IN_MISSION);
  if (githubRepos.length === 0) return deny(REPO_NOT_IN_MISSION);
  if (!inScope(owner, repo, githubRepos)) return deny(REPO_NOT_IN_MISSION);
  return { decision: "allow", path };
}

/**
 * Rewrites/authorizes a GitHub REST request against the mission's repo scope,
 * or refuses it github404-shaped. Deny by default: any catalog-allowed path
 * that isn't `/repos/{owner}/{repo}/...` or `/search/issues`, and any path at
 * all under an empty scope, is a refusal.
 */
export function narrowGithub(
  path: string,
  scope: { githubRepos: string[] },
): GithubNarrowResult {
  const segments = pathSegments(path);
  const [first, second] = segments;

  if (first === "repos" && second !== undefined) {
    return narrowRepoPath(segments, scope.githubRepos, path);
  }
  if (first === "search" && second === "issues") {
    return narrowSearchIssues(path, scope.githubRepos);
  }
  return deny(NOT_IN_CATALOG_SCOPE);
}
