import type { CanonicalRequest } from "./narrow-path";
import { deny, REPO_NOT_IN_MISSION, type GithubNarrowResult } from "./narrow-result";

const AMBIGUOUS_Q = "the search query parameter was given more than once";
const UNBOUNDED_Q =
  "search query carries boolean syntax the forced repo qualifier cannot bound";

const QUALIFIER_PREFIXES = ["repo:", "org:", "user:"];

/** True when `term` is an agent-supplied repo/org/user qualifier (case-insensitive). */
function isStrippedQualifier(term: string): boolean {
  const lowered = term.toLowerCase();
  return QUALIFIER_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/**
 * A term whose meaning depends on GitHub's search grammar rather than on plain
 * conjunction: an operator makes the qualifier we append optional
 * (`is:issue OR repo:acme/x` matches every issue), parentheses regroup it, and
 * a quote can bind — or, once a qualifier is stripped out of a phrase, dangle.
 */
function unbounded(term: string): boolean {
  const lowered = term.toLowerCase();
  if (lowered === "or" || lowered === "and" || lowered === "not") return true;
  return /["()]/.test(term);
}

/**
 * Forces the mission's repos into `/search/issues`, or refuses the query.
 *
 * Deny by default: we do not parse GitHub's search grammar, so appending
 * `repo:` qualifiers is only sound while what remains is a conjunction of
 * plain terms. Anything else — an operator, a grouping, a quote — is refused
 * rather than rewritten into a query that no longer forces the mission's repos.
 *
 * Parameter names are matched case-insensitively: GitHub's own parsing of a
 * `Q=` spelling is not something an allowlist should bet on, so any parameter
 * that lowercases to `q` is sanitized, never forwarded as the agent wrote it.
 */
export function narrowSearchIssues(
  canonical: CanonicalRequest,
  githubRepos: readonly string[],
): GithubNarrowResult {
  if (githubRepos.length === 0) return deny(REPO_NOT_IN_MISSION);

  const params = new URLSearchParams(canonical.search);
  const queries = [...params].filter(([name]) => name.toLowerCase() === "q");
  // Two spellings of the same parameter: whichever one the vendor reads, one
  // of them was not the one we sanitized.
  if (queries.length > 1) return deny(AMBIGUOUS_Q);

  const raw = queries[0]?.[1] ?? "";
  const kept = raw
    .split(/\s+/)
    .filter((term) => term.length > 0 && !isStrippedQualifier(term));
  if (kept.some(unbounded)) return deny(UNBOUNDED_Q);

  const next = new URLSearchParams();
  for (const [name, value] of params) {
    if (name.toLowerCase() === "q") continue;
    next.append(name, value);
  }
  const forced = githubRepos.map((repo) => `repo:${repo}`);
  next.set("q", [...kept, ...forced].join(" "));
  return { decision: "allow", path: `${canonical.path}?${next.toString()}` };
}
