import { narrowGithub as narrowGithubPath } from "@missura/connectors-github";
import { narrowLinear as narrowLinearBody } from "@missura/connectors-linear";
import { narrowZendesk as narrowZendeskPath } from "@missura/connectors-zendesk";
import {
  openEntityGraph,
  resolveMissionScope,
  type MissionResolution,
  type MissionScope,
  type ResolvedScope,
} from "@missura/core";
import type { NarrowFn, NarrowResult } from "@missura/proxy";

export type Resolver = (scope: MissionScope) => MissionResolution;

const UNRESOLVED = "mission scope no longer resolves to an entity";

/**
 * The entity graph is read once, at boot: a proxy must not re-read a file on
 * the hot path, and an operator editing `entities.json` under a running proxy
 * is making a policy change — it takes a restart, deliberately.
 *
 * One resolver for the data planes and the operator plane, so a mission minted
 * on 8480 is enforced against the very graph that admitted it.
 */
export function scopeResolver(entitiesPath: string): Resolver {
  const graph = openEntityGraph(entitiesPath);
  return (scope: MissionScope): MissionResolution =>
    resolveMissionScope(graph, scope);
}

/**
 * Resolution happens per request, from the mission's own claims — the token
 * carries a business scope ("customer:acme") and never a vendor id, so a
 * stolen token cannot name an object the graph does not link to it.
 *
 * An entity that has since disappeared denies: NARROW without a resolved scope
 * has nothing to narrow to, and a request it cannot shrink must not pass.
 */
function resolved(
  resolve: Resolver,
  scope: MissionScope,
): ResolvedScope | undefined {
  try {
    return resolve(scope).scope;
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

/**
 * The organization ids come from the graph and from nowhere else: a Zendesk
 * organization is not something an operator can type on `missura exec`, so a
 * mission reaches Zendesk exactly when a human confirmed the link.
 *
 * An empty set is a refusal inside the connector, not a pass — "everything" is
 * what an unscoped Zendesk credential would otherwise return.
 */
export function zendeskNarrow(resolve: Resolver): NarrowFn {
  return (req, claims): NarrowResult => {
    const scope = resolved(resolve, claims.scope);
    if (scope === undefined) {
      return { decision: "deny", denyShape: "zendesk404", reason: UNRESOLVED };
    }
    return narrowZendeskPath(req.path, {
      zendeskOrganizationIds: [...(scope.zendeskOrganizationIds ?? [])],
    });
  };
}
