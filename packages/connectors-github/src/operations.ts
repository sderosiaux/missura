import type { Operation, OperationStep, ResolvedScope } from "@missura/core";

/**
 * The GitHub operations, beside the route catalog and for the same reason.
 *
 * A plan names TARGETS, taken from the resolved scope; it decides nothing.
 * Every entry gets a step, path-scoped ones included: whether a repository
 * serves its issues is NARROW's rule (`narrow-contents.ts`), and a plan that
 * skipped the entries NARROW would refuse would be a second copy of it.
 */

/** The mission's repositories' open issues: one `repos.issues.list` each. */
export const issuesForEntity: Operation = {
  name: "github.issues.for_entity",
  connector: "github",
  effect: "read",
  needs: "github.repo",
  plan(scope: ResolvedScope): readonly OperationStep[] {
    return scope.githubRepos.map((entry) => ({
      method: "GET",
      path: `/repos/${entry.repo}/issues?state=open`,
      body: "",
    }));
  },
};

export const GITHUB_OPERATIONS: readonly Operation[] = [issuesForEntity];
