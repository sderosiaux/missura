import type { FilterPlan, PaginationRule } from "@missura/core";
import { isVendorName, type CanonicalRequest } from "./narrow-path";
import {
  deny,
  REPO_NOT_IN_MISSION,
  type GithubNarrowResult,
} from "./narrow-result";

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
function searchFilterPlan(
  repositoryOwners: readonly string[],
  pagination: PaginationRule | undefined,
): FilterPlan {
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
    ...(pagination === undefined ? {} : { pagination }),
  };
}

/** GitHub's own defaults and ceiling for a search page. */
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

interface PageParam {
  /** The spelling the agent used, so a rewrite replaces it instead of adding one. */
  name: string;
  value: number;
}

/**
 * One positive-integer query parameter, matched case-insensitively like `q`.
 *
 * `undefined` — not a number, not positive, or given twice — means we cannot
 * say which page the agent asked for, so no pagination rule is emitted and the
 * agent gets a short page. That is the safe half of the tradeoff: a refill
 * driven by a page number we guessed wrong would re-issue the agent's query
 * against a position it never asked about.
 */
function pageParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): PageParam | undefined {
  const found = [...params].filter(([key]) => key.toLowerCase() === name);
  if (found.length === 0) return { name, value: fallback };
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(only[1])) return undefined;
  return { name: only[0], value: Number(only[1]) };
}

/**
 * How the proxy walks `/search/issues` forward: REST pages, not Relay cursors.
 *
 * Without it a filtered search answered short, and a short page is a per-index
 * oracle — `per_page=1&page=N&sort=created&order=asc` reads back the exact
 * interleaving of a foreign repo's issues against the mission's own, hence
 * their count and their approximate dates.
 *
 * `per_page` is clamped to GitHub's own ceiling because that is the largest
 * page the vendor will send: reading "is there more" off a page size the vendor
 * would never honour would end the walk on its first call.
 */
function searchPagination(params: URLSearchParams): PaginationRule | undefined {
  const page = pageParam(params, "page", 1);
  const perPage = pageParam(params, "per_page", DEFAULT_PER_PAGE);
  if (page === undefined || perPage === undefined) return undefined;
  const pageSize = Math.min(perPage.value, MAX_PER_PAGE);
  return {
    path: [],
    nodes: "items",
    requested: pageSize,
    cursor: {
      source: "query-page",
      param: page.name,
      page: page.value,
      pageSize,
    },
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

  const pagination = searchPagination(params);
  const allow = (path: string): GithubNarrowResult => ({
    decision: "allow",
    path,
    // Names the shape a fail-closed FILTER must take on the way back: GitHub's
    // own not-found, so a refusal is indistinguishable from absence.
    denyShape: "github404",
    filterPlan: searchFilterPlan(repositoryOwners, pagination),
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
