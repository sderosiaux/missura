import {
  OperationParameterError,
  type Operation,
  type OperationStep,
  type ResolvedScope,
} from "@missura/core";

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

/** GitHub's own owner/repo charset, on both halves — the same rule the scope is parsed with. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function repoParam(value: unknown): string {
  if (typeof value !== "string" || !REPO_RE.test(value)) {
    throw new OperationParameterError("repo", "must be `owner/name` in GitHub's own charset");
  }
  return value;
}

function issueParam(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new OperationParameterError("issue", "must be a positive integer issue number");
  }
  return value;
}

function bodyParam(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OperationParameterError("body", "must be a non-empty string");
  }
  return value;
}

/**
 * THE FIRST WRITE (M8): one comment on one issue, `effect: "append"`.
 *
 * The plan takes `repo` from the agent and builds the request as the agent
 * would have — it does NOT look the repository up in the scope. Whether the
 * mission covers it is NARROW's decision on the step, taken before anything
 * leaves and answered, for a foreign repository, with the same not-found a
 * read gets (`narrow.ts`). The parameters are checked for SHAPE only, so the
 * path is built from pieces that cannot spell a different route: a repo in
 * GitHub's charset holds no `/` beyond the one, an issue number is digits.
 */
export const issueCommentCreate: Operation = {
  name: "github.issue.comment.create",
  connector: "github",
  effect: "append",
  needs: "github.repo",
  plan(
    _scope: ResolvedScope,
    params: Readonly<Record<string, unknown>>,
  ): readonly OperationStep[] {
    const repo = repoParam(params.repo);
    const issue = issueParam(params.issue);
    const body = bodyParam(params.body);
    return [
      {
        method: "POST",
        path: `/repos/${repo}/issues/${String(issue)}/comments`,
        body: JSON.stringify({ body }),
      },
    ];
  },
};

function commentParam(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new OperationParameterError("comment", "must be a positive integer comment id");
  }
  return value;
}

/**
 * THE DESTROY (M10): one comment, deleted, `effect: "destroy"` — irreversible,
 * so the executor writes it down and waits for a human instead of running
 * it. Same discipline as the append: the repository comes from the agent and
 * is NARROW's to refuse, and a comment id is digits, so the path spells no
 * other route.
 */
export const issueCommentDelete: Operation = {
  name: "github.issue.comment.delete",
  connector: "github",
  effect: "destroy",
  needs: "github.repo",
  plan(
    _scope: ResolvedScope,
    params: Readonly<Record<string, unknown>>,
  ): readonly OperationStep[] {
    const repo = repoParam(params.repo);
    const comment = commentParam(params.comment);
    return [
      {
        method: "DELETE",
        path: `/repos/${repo}/issues/comments/${String(comment)}`,
        body: "",
      },
    ];
  },
};

export const GITHUB_OPERATIONS: readonly Operation[] = [
  issuesForEntity,
  issueCommentCreate,
  issueCommentDelete,
];
