import type { GithubTargets } from "./assume-github";
import type { OperationSpec } from "./classify";
import type { Operation } from "./exchange";

/**
 * HALF B, GitHub — the catalogued routes, and two families the catalog does not
 * admit.
 *
 * GitHub is the connector with the least to filter: every catalogued route
 * NAMES its repository in the path, so the mission scope is checked before the
 * call rather than proven after it. The one exception is `search.issues`, where
 * the repository is a query qualifier and the connector forces it in — which is
 * the only Github operation this half expects to see rewritten.
 */

/**
 * `link` is a vendor position over the UNFILTERED list, dropped whenever a plan
 * applies. It is a header, not a body path, so it is recorded by the classifier
 * as a note; nothing here declares it.
 */
const NO_STRIPS: readonly string[] = [];

const PAGE = 2;

function spec(
  over: Partial<OperationSpec> & { operation: string; request: string },
): OperationSpec {
  return {
    vendor: "github",
    narrowed: [],
    filtered: [],
    refused: [],
    strips: NO_STRIPS,
    ...over,
  };
}

function get(specification: OperationSpec, path: string): Operation {
  return { spec: specification, method: "GET", path };
}

function repoScoped(operation: string, request: string): OperationSpec {
  return spec({
    operation,
    request,
    narrowed: ["refused unless {owner}/{repo} is a repository the mission covers"],
  });
}

export function githubOperations(targets: GithubTargets): Operation[] {
  const repo = targets.repo;
  const out: Operation[] = [
    get(
      repoScoped("repos.get", "GET /repos/{owner}/{repo}"),
      `/repos/${repo}`,
    ),
    get(
      repoScoped(
        "repos.issues.list",
        "GET /repos/{owner}/{repo}/issues?per_page=2&state=all",
      ),
      `/repos/${repo}/issues?per_page=${String(PAGE)}&state=all`,
    ),
    get(
      repoScoped("repos.pulls.list", "GET /repos/{owner}/{repo}/pulls?per_page=2&state=all"),
      `/repos/${repo}/pulls?per_page=${String(PAGE)}&state=all`,
    ),
    get(
      repoScoped("repos.contents.get", "GET /repos/{owner}/{repo}/contents"),
      `/repos/${repo}/contents`,
    ),
    get(
      spec({
        operation: "search.issues",
        request: "GET /search/issues?q=repo:{owner}/{repo} is:issue&per_page=2",
        narrowed: [
          "the agent's own `repo:` / `org:` / `user:` qualifiers are replaced by the mission's repositories",
        ],
        filtered: [
          "results outside the mission's repositories are dropped, and the `total_count` beside them with it",
        ],
        strips: ["total_count", "incomplete_results"],
      }),
      `/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue`)}&per_page=${String(PAGE)}`,
    ),
  ];

  const issue = targets.issueNumber;
  if (issue !== undefined) {
    out.push(
      get(
        repoScoped("repos.issues.get", "GET /repos/{owner}/{repo}/issues/{number}"),
        `/repos/${repo}/issues/${issue}`,
      ),
      get(
        repoScoped(
          "repos.issues.comments.list",
          "GET /repos/{owner}/{repo}/issues/{number}/comments?per_page=2",
        ),
        `/repos/${repo}/issues/${issue}/comments?per_page=${String(PAGE)}`,
      ),
    );
  }
  const pull = targets.pullNumber;
  if (pull !== undefined) {
    out.push(
      get(
        repoScoped("repos.pulls.get", "GET /repos/{owner}/{repo}/pulls/{number}"),
        `/repos/${repo}/pulls/${pull}`,
      ),
    );
  }
  const nested = targets.nestedPath;
  if (nested?.includes("/") === true) {
    out.push(
      get(
        spec({
          operation: "repos.contents.get (encoded separator)",
          request: "GET /repos/{owner}/{repo}/contents/{dir}%2F{file}",
          narrowed: [
            "the path is DECODED before the scope check and re-encoded before it travels, so `..%2f..%2f` cannot leave the repository",
          ],
        }),
        `/repos/${repo}/contents/${nested.split("/").map(encodeURIComponent).join("%2F")}`,
      ),
    );
  }

  out.push(
    {
      spec: spec({
        operation: "refused.identity",
        request: "GET /user",
        refused: ["the authenticated-user endpoint is not in the GitHub read catalog"],
      }),
      method: "GET",
      path: "/user",
      skipDirect: true,
    },
    {
      spec: spec({
        operation: "refused.uncatalogued",
        request: "GET /repos/{owner}/{repo}/collaborators",
        refused: ["a route absent from the catalog fails closed — deny by default"],
      }),
      method: "GET",
      path: `/repos/${repo}/collaborators`,
      skipDirect: true,
    },
  );
  return out;
}
