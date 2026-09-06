import type { FilterPlan, ParentProof } from "@missura/core";
import { REPOS_URL_PREFIX, type CanonicalRequest } from "./narrow-path";
import type { GithubNarrowResult } from "./narrow-result";

/**
 * ONE COMMENT BY ID — `/repos/{o}/{r}/issues/comments/{id}` — read or
 * destroyed (L8).
 *
 * A GitHub comment id is GLOBAL: `9001` names one comment across every
 * repository, and the `{o}/{r}` in the path is how the agent spelled the
 * request, not where the comment lives. The repository check NARROW makes on
 * the path is therefore necessary and not sufficient here, and the proof is
 * the comment itself: GitHub answers it with its own `url`,
 * `https://api.github.com/repos/{owner}/{repo}/issues/comments/{id}` — one
 * exact string, fully determined by the repository and the id. `issue_url`
 * would do as well but needs a prefix rule the engine does not have and
 * should not grow. Case-insensitive on the repository half because GitHub
 * names one case-insensitively and answers with the casing it stored.
 *
 *   - a READ runs and its answer is filtered on that `url` — a comment that
 *     lives elsewhere fails closed into GitHub's own not-found;
 *   - a DESTROY cannot be filtered after the fact, so it proves the comment
 *     FIRST, through the read above as its parent proof, re-proven right
 *     before the DELETE and never from the memo (`parent-proof.ts`).
 */

/** The comment's own `url`, as GitHub will spell it for this repository and id. */
function commentUrl(repo: string, id: string): string {
  return `${REPOS_URL_PREFIX}${repo}/issues/comments/${id}`;
}

export function isCommentById(canonical: CanonicalRequest): boolean {
  const [first, , , issues, comments, id, tail] = canonical.segments;
  return (
    first === "repos" &&
    issues === "issues" &&
    comments === "comments" &&
    id !== undefined &&
    /^[1-9][0-9]*$/.test(id) &&
    tail === undefined
  );
}

/** The read: the answer proven on the comment's own `url`. */
export function commentReadPlan(repo: string, id: string): FilterPlan {
  return {
    rules: [
      {
        path: [],
        type: "issue-comment",
        ownerPath: ["url"],
        expectedOwnerIds: [commentUrl(repo, id)],
        ownerMatch: "ascii-case-insensitive",
        injected: [],
        nullable: false,
      },
    ],
    strip: [],
  };
}

/** The destroy: the comment proven first, through the read. */
export function commentProof(repo: string, id: string): ParentProof {
  return {
    key: `comment:${repo}:${id}`,
    probe: { method: "GET", path: `/repos/${repo}/issues/comments/${id}`, body: "" },
    ownerPath: ["url"],
    ownerMatch: "ascii-case-insensitive",
  };
}

/**
 * The comment route on a repository the mission holds whole, decided by
 * method: the read gets the plan, the destroy gets the proof. `allowed` is
 * the canonical target, already re-shown to the catalog with the request's
 * own method and origin by the caller.
 */
export function narrowComment(
  canonical: CanonicalRequest,
  method: string,
  allowed: GithubNarrowResult,
): GithubNarrowResult {
  if (allowed.decision === "deny") return allowed;
  const [, owner, repo, , , id] = canonical.segments;
  const target = `${owner ?? ""}/${repo ?? ""}`;
  if (method === "DELETE") {
    return {
      ...allowed,
      denyShape: "github404",
      parentProof: commentProof(target, id ?? ""),
      missionOwnerIds: [commentUrl(target, id ?? "")],
    };
  }
  return { ...allowed, denyShape: "github404", filterPlan: commentReadPlan(target, id ?? "") };
}
