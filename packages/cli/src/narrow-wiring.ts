import { narrowGithub as narrowGithubPath } from "@missura/connectors-github";
import { narrowLinear as narrowLinearBody } from "@missura/connectors-linear";
import {
  loadEntityMap,
  resolveScope,
  type MissionScope,
  type ResolvedScope,
} from "@missura/core";
import type { NarrowFn, NarrowResult } from "@missura/proxy";

export type Resolver = (scope: MissionScope) => ResolvedScope;

const UNRESOLVED = "mission scope no longer resolves to an entity";

/**
 * The entity map is read once, at boot: a proxy must not re-read a file on the
 * hot path, and an operator editing `entities.json` under a running proxy is
 * making a policy change — it takes a restart, deliberately.
 */
export function scopeResolver(entitiesPath: string): Resolver {
  const map = loadEntityMap(entitiesPath);
  return (scope: MissionScope): ResolvedScope => resolveScope(map, scope);
}

/**
 * Resolution happens per request, from the mission's own claims — the token
 * carries a business scope ("customer:acme") and never a vendor id, so a
 * stolen token cannot name an object the entity map does not map to it.
 *
 * An entity that has since disappeared denies: NARROW without a resolved scope
 * has nothing to narrow to, and a request it cannot shrink must not pass.
 */
function resolved(
  resolve: Resolver,
  scope: MissionScope,
): ResolvedScope | undefined {
  try {
    return resolve(scope);
  } catch {
    return undefined;
  }
}

export function linearNarrow(resolve: Resolver): NarrowFn {
  return (req, claims): NarrowResult => {
    const scope = resolved(resolve, claims.scope);
    if (scope === undefined) return { decision: "deny", reason: UNRESOLVED };
    return narrowLinearBody(req.body, {
      ...(scope.linearCustomerId === undefined
        ? {}
        : { linearCustomerId: scope.linearCustomerId }),
    });
  };
}

export function githubNarrow(resolve: Resolver): NarrowFn {
  return (req, claims): NarrowResult => {
    const scope = resolved(resolve, claims.scope);
    if (scope === undefined) {
      return { decision: "deny", denyShape: "github404", reason: UNRESOLVED };
    }
    return narrowGithubPath(req.path, { githubRepos: scope.githubRepos });
  };
}
