import { pathPrefixSegments, type GithubRepoScope } from "@missura/core";
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
 *
 * The check runs on the CANONICAL segments — decoded, dot-collapsed, the ones
 * the vendor will act on — and the canonical request is what then travels. That
 * is the same normalization the repository half already relies on, so `%2f`,
 * `%252f`, `..%5c` and a plain `..` are all the same path here and none of them
 * can walk out of the prefix. Comparison is per SEGMENT (`abcam` is not
 * `abcam-corp`) and case-SENSITIVE, because git paths are: folding them would
 * let a mission for `Abcam` read the different directory `abcam`.
 */

/** The sub-resource a path prefix can bound, and the only one. */
export const CONTENTS = "contents";

export const PATH_SCOPED_REPO =
  "this repository is in the mission by PATH, and only `contents` under that path is served";
export const OUTSIDE_PREFIX = "path outside the mission's path";
/**
 * The subtle one. A listing whose own path is a STRICT ANCESTOR of the prefix
 * answers with every entry of that directory — one per customer, in the shape
 * this exists to protect — so the answer IS the list the mission does not
 * cover. Serving a filtered version would be a different answer from the
 * vendor's rather than a narrower one, and nothing on a listing entry could
 * prove ownership anyway.
 */
export const ANCESTOR_LISTING =
  "a listing above the mission's path enumerates directories beside it";

/**
 * Every refusal here is `missura_out_of_path_scope`, not the generic
 * out-of-scope code: the remediation for the two is different, and the generic
 * one would point the agent at `/search/issues` — a route a path-scoped mission
 * also refuses.
 */
export function pathScopedDeny(reason: string): GithubNarrowResult {
  return deny(reason, "missura_out_of_path_scope");
}

function atOrBelow(target: readonly string[], prefix: readonly string[]): boolean {
  return (
    target.length >= prefix.length &&
    prefix.every((segment, i) => target[i] === segment)
  );
}

function isStrictAncestor(
  target: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    target.length < prefix.length &&
    target.every((segment, i) => prefix[i] === segment)
  );
}

/**
 * Decides a request against the mission's prefixes for this repository. `allow`
 * is the caller's own allow — the canonical request shown to the catalog again
 * — so the prefix check adds a condition and never a second way to say yes.
 */
export function narrowPathScoped(
  canonical: CanonicalRequest,
  entries: readonly GithubRepoScope[],
  allow: () => GithubNarrowResult,
): GithubNarrowResult {
  if (canonical.segments[3] !== CONTENTS) {
    return pathScopedDeny(PATH_SCOPED_REPO);
  }
  const target = canonical.segments.slice(4);
  // An entry with no prefix is DROPPED rather than defaulted: this function is
  // only reached when every entry carries one, and a default here — "" or the
  // whole repository — would be a second, silent way to say yes.
  const prefixes = entries
    .map((entry) => entry.pathPrefix)
    .filter((prefix): prefix is string => prefix !== undefined)
    .map(pathPrefixSegments);
  if (prefixes.some((prefix) => atOrBelow(target, prefix))) return allow();
  return pathScopedDeny(
    prefixes.some((prefix) => isStrictAncestor(target, prefix))
      ? ANCESTOR_LISTING
      : OUTSIDE_PREFIX,
  );
}
