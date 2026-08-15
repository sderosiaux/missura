/**
 * RESOLUTION — turning what a mission was scoped to into vendor targets, using
 * the entity graph and only the parts of it a human signed off.
 *
 * Three directions, and the third is the one that keeps the graph honest:
 *
 *   1. FORWARD  — an entity key to its confirmed links. Today's `resolveScope`,
 *      restricted to `confirmed`.
 *   2. REVERSE  — a native system id to the entity holding a CONFIRMED link to
 *      it, and from there to that entity's other confirmed links. This is what
 *      an event-driven agent needs: a Zendesk webhook hands you an
 *      `organization_id` at 3am, not a business entity name.
 *   3. NATIVE-ONLY — no entity at all. The scope is the native id, the mission
 *      is single-system, and every other connector denies.
 *
 * Two invariants, both structural rather than documented:
 *
 *   ONLY A `confirmed` LINK WIDENS. `proposed`, `rejected` and `broken` are all
 *   read as absent, whatever the method that found them. So a bad inference
 *   cannot cause a leak: the worst it can do is leave a mission narrower than
 *   it could have been.
 *
 *   THE GRAPH ONLY ADDS. Direction 3 needs no entity, no link and no graph file
 *   — `NativeScopeResolution` types that out: exactly one system, and `used` is
 *   the empty tuple, so "the graph widened this" is a type-level impossibility
 *   there.
 *
 * RESOLUTION NEVER WAITS FOR A HUMAN. There is nobody to confirm anything at
 * 3am, so an unconfirmed link never blocks a mint — it DEGRADES it, and the
 * degradation is returned as data (`degraded`) rather than as an absence, so
 * "this mission ran narrow because the Linear link is only proposed" is a
 * queryable fact afterwards instead of a mystery.
 *
 * The one thing that still throws is a scope that names an entity which is not
 * there: a mission whose entity vanished must fail to be minted, not quietly
 * become an unscoped one. A malformed graph threw earlier still, at load.
 */

import type { ResolvedScope } from "./entities";
import {
  LINK_SYSTEMS,
  isConfirmed,
  type Entity,
  type EntityLink,
  type EntityLinkRef,
  type LinkSystem,
} from "./entity-graph";
import type { EntityGraphReader } from "./entity-graph-store";
import { githubRepoScopeKey, parseGithubRepoScope } from "./github-scope";

/** What a mission was scoped to, before the graph is consulted. */
export type ScopeRequest =
  | { kind: "entity"; key: string }
  | { kind: "native"; system: LinkSystem; id: string };

/** One confirmed link the scope was built from. Provenance, for the audit. */
export interface LinkUse {
  system: LinkSystem;
  id: string;
  /** Always `confirmed` — nothing else is ever used. Recorded, not implied. */
  status: "confirmed";
}

/**
 * Why a system is NOT in the scope, when the graph knew something about it.
 *
 *   - `no_entity`        — the native id matches no entity at all.
 *   - `ambiguous_entity` — two entities hold a confirmed link to that id.
 *   - `link_proposed` / `link_rejected` / `link_broken` — a link exists and is
 *     not usable.
 *
 * For the first two the `system` is the one the native id belongs to: that id
 * is still in scope, but nothing else was added through it.
 */
export type DegradeReason =
  | "no_entity"
  | "ambiguous_entity"
  | "link_proposed"
  | "link_rejected"
  | "link_broken";

export interface ScopeDegradation {
  system: LinkSystem;
  reason: DegradeReason;
  id: string;
}

interface ResolutionBase {
  scope: ResolvedScope;
  /** Systems the scope actually covers. Every other connector denies. */
  systems: readonly LinkSystem[];
  used: readonly LinkUse[];
  degraded: readonly ScopeDegradation[];
}

export interface EntityScopeResolution extends ResolutionBase {
  via: "entity";
  entityKey: string;
}

/** No entity was involved, so exactly one system and no link was ever used. */
export interface NativeScopeResolution extends ResolutionBase {
  via: "native";
  systems: readonly [LinkSystem];
  used: readonly [];
}

export type ScopeResolution = EntityScopeResolution | NativeScopeResolution;

function reasonForStatus(link: EntityLink): DegradeReason {
  if (link.status === "rejected") return "link_rejected";
  if (link.status === "broken") return "link_broken";
  return "link_proposed";
}

interface Draft {
  linearCustomerId?: string;
  githubRepos: ResolvedScope["githubRepos"];
  zendeskOrganizationIds: string[];
  seenRepo: Set<string>;
}

function draft(): Draft {
  return { githubRepos: [], zendeskOrganizationIds: [], seenRepo: new Set() };
}

/**
 * Adds one native id to the scope being built. `parseGithubRepoScope` throws on
 * a spelling nobody could enforce — the graph's own ids were checked at load, so
 * only a caller-supplied native id can fail here, and failing is right: a repo
 * we cannot read must not become a wider grant than the caller wrote.
 */
function add(into: Draft, system: LinkSystem, id: string): void {
  if (system === "linear") {
    into.linearCustomerId ??= id;
    return;
  }
  if (system === "github") {
    const repo = parseGithubRepoScope(id);
    const key = githubRepoScopeKey(repo);
    if (into.seenRepo.has(key)) return;
    into.seenRepo.add(key);
    into.githubRepos.push(repo);
    return;
  }
  if (!into.zendeskOrganizationIds.includes(id)) {
    into.zendeskOrganizationIds.push(id);
  }
}

function finish(into: Draft): ResolvedScope {
  return {
    ...(into.linearCustomerId === undefined
      ? {}
      : { linearCustomerId: into.linearCustomerId }),
    githubRepos: into.githubRepos,
    zendeskOrganizationIds: into.zendeskOrganizationIds,
  };
}

/** In the graph's own system order, so two resolutions compare field by field. */
function systemsOf(scope: ResolvedScope): LinkSystem[] {
  return LINK_SYSTEMS.filter((system) => {
    if (system === "linear") return scope.linearCustomerId !== undefined;
    if (system === "github") return scope.githubRepos.length > 0;
    return (scope.zendeskOrganizationIds ?? []).length > 0;
  });
}

function throughEntity(entity: Entity): EntityScopeResolution {
  const into = draft();
  const used: LinkUse[] = [];
  const degraded: ScopeDegradation[] = [];
  for (const link of entity.links) {
    if (!isConfirmed(link)) {
      degraded.push({
        system: link.system,
        reason: reasonForStatus(link),
        id: link.id,
      });
      continue;
    }
    add(into, link.system, link.id);
    used.push({ system: link.system, id: link.id, status: "confirmed" });
  }
  const scope = finish(into);
  return {
    via: "entity",
    entityKey: entity.key,
    scope,
    systems: systemsOf(scope),
    used,
    degraded,
  };
}

function nativeOnly(
  system: LinkSystem,
  id: string,
  reason: DegradeReason,
): NativeScopeResolution {
  const into = draft();
  add(into, system, id);
  return {
    via: "native",
    scope: finish(into),
    systems: [system],
    used: [],
    degraded: [{ system, reason, id }],
  };
}

/**
 * Why the graph did not carry us to an entity. A link that exists but is not
 * confirmed is a different fact from an id nobody has ever seen, and an operator
 * chasing a narrow mission needs to be told which one it was.
 */
function whyNoEntity(refs: readonly EntityLinkRef[]): DegradeReason {
  if (refs.length === 0) return "no_entity";
  const statuses = refs.map((r) => r.link.status);
  if (statuses.includes("proposed")) return "link_proposed";
  if (statuses.includes("broken")) return "link_broken";
  return "link_rejected";
}

export function resolveScopeFromGraph(
  reader: EntityGraphReader,
  request: ScopeRequest,
): ScopeResolution {
  if (request.kind === "entity") {
    const entity = reader.entity(request.key);
    if (entity === undefined) throw new Error(`unknown entity: ${request.key}`);
    return throughEntity(entity);
  }
  const refs = reader.linksTo(request.system, request.id);
  const confirmed = refs.filter((r) => isConfirmed(r.link));
  const keys = new Set(confirmed.map((r) => r.entityKey));
  // Two entities holding the same confirmed id has no honest answer, and
  // picking one is how a mission reaches somebody else's data. Degrade to the
  // id we were handed — which is the narrowest thing that still works.
  if (keys.size > 1) {
    return nativeOnly(request.system, request.id, "ambiguous_entity");
  }
  const [key] = keys;
  if (key === undefined) {
    return nativeOnly(request.system, request.id, whyNoEntity(refs));
  }
  const entity = reader.entity(key);
  if (entity === undefined) throw new Error(`unknown entity: ${key}`);
  return throughEntity(entity);
}
