import type { FilterPlan } from "@missura/core";
import { isVendorName, type CanonicalRequest } from "./narrow-path";
import { deny, REPO_NOT_IN_MISSION, type GithubNarrowResult } from "./narrow-result";

const AMBIGUOUS_Q = "the search query parameter was given more than once";
const UNNAMEABLE_REPO = "mission repo outside GitHub's own naming charset";

const QUALIFIER_PREFIXES = ["repo:", "org:", "user:"];

/**
 * How a search item names its repository, VERIFIED against the live API:
 * `GET /search/issues` returns ISSUES, and an issue carries `repository_url`
 * — `https://api.github.com/repos/{owner}/{repo}` — not a `repository` object.
 * The origin is github.com's: a GitHub Enterprise host would answer with its
 * own, no item would match, and the mission would see an empty result set.
 * That is the fail-closed direction, and GHES is not in this connector's scope.
 */
const REPOS_URL_PREFIX = "https://api.github.com/repos/";

/** True when `term` is an agent-supplied repo/org/user qualifier (case-insensitive). */
function isStrippedQualifier(term: string): boolean {
  const lowered = term.toLowerCase();
  return QUALIFIER_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/**
 * A term whose meaning depends on GitHub's search grammar rather than on plain
 * conjunction: an operator makes an appended qualifier optional
 * (`is:issue OR repo:acme/x` matches every issue), parentheses regroup it, and
 * a quote can bind — or, once a qualifier is stripped out of a phrase, dangle.
 */
function usesGrammar(term: string): boolean {
  const lowered = term.toLowerCase();
  if (lowered === "or" || lowered === "and" || lowered === "not") return true;
  return /["()]/.test(term);
}

/**
 * The mission's repos as the URLs the vendor will put in `repository_url`.
 * `undefined` when a repo is not something GitHub could name: an owner or repo
 * outside `[A-Za-z0-9._-]` can never match a real item, and planning against
 * it would silently filter every result away instead of saying so.
 */
function repositoryUrls(
  githubRepos: readonly string[],
): readonly string[] | undefined {
  const urls: string[] = [];
  for (const repo of githubRepos) {
    const [owner, name, ...extra] = repo.split("/");
    if (owner === undefined || name === undefined || extra.length > 0) {
      return undefined;
    }
    if (!isVendorName(owner) || !isVendorName(name)) return undefined;
    urls.push(`${REPOS_URL_PREFIX}${owner}/${name}`);
  }
  return urls;
}

/**
 * One rule over the whole result page, holding EVERY mission repo at once: a
 * result is ours when its repository is any of them, which is exactly what a
 * per-repo rule could not say. The comparison is ASCII-case-insensitive
 * because GitHub resolves `repo:` without regard to case but answers with the
 * casing it stored, so a mission typed `Acme-Corp/Product` still matches.
 *
 * Nothing is injected and nothing is stripped: the discriminator is a field
 * GitHub sends on every item, so the ownership proof costs the agent nothing.
 */
function searchFilterPlan(repositoryOwners: readonly string[]): FilterPlan {
  return {
    rules: [
      {
        path: ["items", "*"],
        type: "issue-search-result-item",
        ownerPath: ["repository_url"],
        expectedOwnerIds: repositoryOwners,
        ownerMatch: "ascii-case-insensitive",
        injected: [],
        nullable: false,
      },
    ],
    strip: [],
  };
}

/**
 * Runs `/search/issues` under a filter plan, forcing the mission's repos into
 * the query when — and only when — that is sound.
 *
 * M2 refused every query carrying GitHub's boolean grammar, because appending
 * `repo:` qualifiers to `is:issue OR repo:globex/secret` yields a query that
 * forces nothing. The refusal goes with the enforcement point (SPEC §4.4.2):
 * the response is filtered, so the grammar is legitimate again.
 *
 * What has NOT changed is that we do not parse that grammar. So:
 *   - a plain conjunction of terms is rewritten — the agent's own `repo:` /
 *     `org:` / `user:` qualifiers are dropped and the mission's appended.
 *     Cheaper than filtering and lighter on the vendor, and never instead of
 *     the filter;
 *   - anything else travels EXACTLY as the agent wrote it. Removing a term
 *     from a boolean expression changes it in ways we cannot predict
 *     (`a OR repo:x` would become `a OR`), and rewriting a grammar we cannot
 *     read is the mistake — the M2 refusal was the cover for it.
 *
 * Either way the response filter is what proves ownership, and it is attached
 * to both branches.
 *
 * Parameter names are matched case-insensitively: GitHub's own parsing of a
 * `Q=` spelling is not something an allowlist should bet on. Two spellings at
 * once still deny — whichever the vendor reads, one of them is not the one we
 * decided on, and the audit record would name a query nobody ran.
 */
export function narrowSearchIssues(
  canonical: CanonicalRequest,
  githubRepos: readonly string[],
): GithubNarrowResult {
  if (githubRepos.length === 0) return deny(REPO_NOT_IN_MISSION);
  const repositoryOwners = repositoryUrls(githubRepos);
  if (repositoryOwners === undefined) return deny(UNNAMEABLE_REPO);

  const params = new URLSearchParams(canonical.search);
  const queries = [...params].filter(([name]) => name.toLowerCase() === "q");
  if (queries.length > 1) return deny(AMBIGUOUS_Q);

  const allow = (path: string): GithubNarrowResult => ({
    decision: "allow",
    path,
    // Names the shape a fail-closed FILTER must take on the way back: GitHub's
    // own not-found, so a refusal is indistinguishable from absence.
    denyShape: "github404",
    filterPlan: searchFilterPlan(repositoryOwners),
  });

  const raw = queries[0]?.[1] ?? "";
  const kept = raw
    .split(/\s+/)
    .filter((term) => term.length > 0 && !isStrippedQualifier(term));
  if (kept.some(usesGrammar)) {
    return allow(`${canonical.path}${canonical.search}`);
  }

  const next = new URLSearchParams();
  for (const [name, value] of params) {
    if (name.toLowerCase() === "q") continue;
    next.append(name, value);
  }
  const forced = githubRepos.map((repo) => `repo:${repo}`);
  next.set("q", [...kept, ...forced].join(" "));
  return allow(`${canonical.path}?${next.toString()}`);
}
