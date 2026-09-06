/**
 * THE ONE WAY A MISSION SCOPE BECOMES VENDOR TARGETS.
 *
 * `entity-resolve.ts` answers what the GRAPH knows; this file is what a MINT
 * asks, and it is the only entry point the CLI and the operator plane use. The
 * difference is the explicit repositories: `--repo owner/name` is a grant the
 * operator typed, it lives in no graph, and it is unioned on top of whatever
 * the graph answered.
 *
 * The two halves are kept apart on the way out. `scope` is what gets enforced;
 * `resolution` is the graph's own account of its half — the confirmed links it
 * used and the ones it declined to — and it is ABSENT when the graph was never
 * consulted. Folding an operator-typed repository into the provenance would
 * claim a link nobody ever confirmed.
 *
 * A degradation is not an absence here either. It rides out on `resolution` so
 * it can reach the mission record and the decision log: "this mission ran
 * without Linear because the link is only proposed" is the answer the whole
 * design exists to be able to give, and a mint that silently dropped it would
 * be the failure mode it exists to avoid.
 */

import type { ResolvedScope } from "./resolved-scope";
import type { EntityGraphReader } from "./entity-graph-store";
import {
  resolveScopeFromGraph,
  scopeRequestFor,
  type ScopeResolution,
} from "./entity-resolve";
import { githubRepoScopeKey, parseGithubRepoScope } from "./github-scope";
import type { MissionScope } from "./token";

export interface MissionResolution {
  /** What the mission is enforced against: the graph's answer plus the repos. */
  scope: ResolvedScope;
  /** Present exactly when the graph was asked something. */
  resolution?: ScopeResolution;
}

/**
 * Two entries on the same repository with different path prefixes are two
 * distinct grants and both survive; a bare entry alongside a prefixed one does
 * too, and the connector reads the bare one as the wider grant it is.
 */
function withRepos(
  scope: ResolvedScope,
  repos: readonly string[],
): ResolvedScope {
  if (repos.length === 0) return scope;
  const githubRepos = [...scope.githubRepos];
  const seen = new Set(githubRepos.map(githubRepoScopeKey));
  for (const raw of repos) {
    // Throws on a spelling nobody could enforce — before a token exists, not at
    // the first request it would have decided.
    const repo = parseGithubRepoScope(raw);
    const key = githubRepoScopeKey(repo);
    if (seen.has(key)) continue;
    seen.add(key);
    githubRepos.push(repo);
  }
  return { ...scope, githubRepos };
}

const NOTHING: ResolvedScope = { githubRepos: [], zendeskOrganizationIds: [] };

export function resolveMissionScope(
  reader: EntityGraphReader,
  scope: MissionScope,
): MissionResolution {
  const request = scopeRequestFor(scope);
  const resolution =
    request === undefined ? undefined : resolveScopeFromGraph(reader, request);
  return {
    scope: withRepos(resolution?.scope ?? NOTHING, scope.repos ?? []),
    ...(resolution === undefined ? {} : { resolution }),
  };
}
