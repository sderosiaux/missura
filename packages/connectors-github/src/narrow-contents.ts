import type { GithubRepoScope } from "@missura/core";
import type { CanonicalRequest } from "./narrow-path";
import { deny, type GithubNarrowResult } from "./narrow-result";

/**
 * A repository the mission covers only a PATH of.
 *
 * FAIL CLOSED, first. A path prefix bounds exactly one thing: the path in
 * `GET /repos/{o}/{r}/contents/{path}`. Nothing else the catalog admits on that
 * repository carries a path at all — an issue, a pull request, the repository
 * object itself name no directory, so nothing about them proves which customer
 * they belong to. Under a prefixed entry every one of them is refused by name;
 * a BARE entry is untouched and keeps meaning the whole repository.
 */

/** The sub-resource a path prefix can bound, and the only one. */
export const CONTENTS = "contents";

export const PATH_SCOPED_REPO =
  "this repository is in the mission by PATH, and only `contents` under that path is served";

/**
 * Every refusal here is `missura_out_of_path_scope`, not the generic
 * out-of-scope code: the remediation for the two is different, and the generic
 * one would point the agent at `/search/issues` — a route a path-scoped mission
 * also refuses.
 */
export function pathScopedDeny(reason: string): GithubNarrowResult {
  return deny(reason, "missura_out_of_path_scope");
}

export function narrowPathScoped(
  canonical: CanonicalRequest,
  entries: readonly GithubRepoScope[],
  allow: () => GithubNarrowResult,
): GithubNarrowResult {
  void entries;
  void allow;
  return pathScopedDeny(PATH_SCOPED_REPO);
}
