import type { Octokit } from "octokit";
import { check, SkipCheck, type CheckResult, type MissionClaims } from "./mission";

/**
 * The GitHub half of the M3 proof.
 *
 * M2 REFUSED any search query using GitHub's boolean grammar, because forcing
 * the mission's `repo:` qualifiers into `a OR b` produces a query that means
 * something else. M3 lets it run and filters the results instead (SPEC §4.4.2),
 * so `OR` and quoted phrases are legitimate again — and the honesty of the
 * page is what has to be checked in their place.
 */

const DEFAULT_QUERY = '"fix" OR "bug"';
const REPOS_URL_PREFIX = "https://api.github.com/repos/";

function repoOf(repositoryUrl: string): string {
  return repositoryUrl.startsWith(REPOS_URL_PREFIX)
    ? repositoryUrl.slice(REPOS_URL_PREFIX.length).toLowerCase()
    : repositoryUrl.toLowerCase();
}

function searchQuery(): string {
  const configured = process.env.MISSURA_SEARCH_QUERY?.trim() ?? "";
  return configured === "" ? DEFAULT_QUERY : configured;
}

/**
 * A filtered page must not carry the vendor's own count: it counted objects we
 * removed, and keeping it would say how many the mission was not allowed to
 * see. `incomplete_results` moves the other way — a page a plan touched is not
 * a complete answer, whether or not anything was actually dropped.
 */
function assertHonestPage(data: Record<string, unknown>, kept: number): string {
  const raw: unknown = data.total_count;
  const total = typeof raw === "number" ? raw : undefined;
  if (total !== undefined && total !== kept) {
    throw new Error(
      `total_count is still the vendor's ${String(total)} for ${String(kept)} result(s) we serve`,
    );
  }
  if (data.incomplete_results !== true) {
    throw new Error("incomplete_results is not true on a filtered page");
  }
  return total === undefined ? "total_count removed" : `total_count ${String(total)}`;
}

/** Check 5: the query M2 refused, now run and filtered. */
export async function githubSearchCheck(
  results: CheckResult[],
  octokit: Octokit,
  claims: MissionClaims,
): Promise<void> {
  const mission = claims.repos.map((repo) => repo.toLowerCase());

  await check(
    results,
    "5 · github search — OR + a quoted phrase run, mission repos only",
    async () => {
      if (mission.length === 0) {
        throw new SkipCheck("mission carries no repos — add --repo owner/name");
      }
      const q = searchQuery();
      const res = await octokit.request("GET /search/issues", {
        q,
        advanced_search: "true",
      });
      const outside = res.data.items
        .map((item) => repoOf(item.repository_url))
        .filter((repo) => !mission.includes(repo));
      if (outside.length > 0) {
        throw new Error(`results from outside the mission: ${[...new Set(outside)].join(", ")}`);
      }
      const counts = assertHonestPage(res.data, res.data.items.length);
      if (res.data.items.length === 0) {
        throw new SkipCheck(
          `\`${q}\` ran (no refusal) but matched nothing in your repos — set MISSURA_SEARCH_QUERY to words your issues use`,
        );
      }
      return `\`${q}\` → ${String(res.data.items.length)} result(s), all mission repos, ${counts}`;
    },
  );
}

/**
 * Check 7: the headers an SDK's retry logic reads. M1 relayed `content-type`
 * and nothing else, so every `x-ratelimit-*` died at the proxy.
 */
export async function githubHeadersCheck(
  results: CheckResult[],
  octokit: Octokit,
  claims: MissionClaims,
): Promise<void> {
  const inScope = claims.repos[0];

  await check(
    results,
    "7 · vendor rate-limit headers reach the client",
    async () => {
      if (inScope === undefined) {
        throw new SkipCheck("mission carries no repos — add --repo owner/name");
      }
      const [owner, name] = inScope.split("/");
      const res = await octokit.request("GET /repos/{owner}/{repo}", {
        owner: owner ?? "",
        repo: name ?? "",
      });
      const limit = res.headers["x-ratelimit-limit"];
      const remaining = res.headers["x-ratelimit-remaining"];
      const reset = res.headers["x-ratelimit-reset"];
      if (limit === undefined || remaining === undefined) {
        throw new Error(
          "no x-ratelimit-* header survived the proxy — an SDK's retry logic is flying blind",
        );
      }
      return `x-ratelimit-limit ${limit}, remaining ${remaining}, reset ${reset ?? "-"}`;
    },
  );
}
