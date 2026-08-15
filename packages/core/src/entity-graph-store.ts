/**
 * THE STORE — the only thing that knows where the graph lives.
 *
 * Resolution takes an `EntityGraphReader`, never a path. The graph is a JSON
 * file today and the human is explicit that it becomes a real stateful database
 * later; keeping the backend behind this interface means that swap touches one
 * adapter and none of the enforcement logic. Nothing below `openEntityGraph`
 * mentions a filesystem.
 *
 * The read half is separated from the write half on purpose: the proxy and the
 * mint path only ever read, so they cannot be handed an object that could
 * confirm a link.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import {
  linkKey,
  type Entity,
  type EntityGraph,
  type EntityLink,
  type EntityLinkRef,
  type LinkMethod,
  type LinkStatus,
  type LinkSystem,
} from "./entity-graph";
import {
  assertSingleValued,
  parseEntityGraph,
  serializeEntityGraph,
} from "./entity-graph-parse";

export { parseEntityGraph, serializeEntityGraph };

/** What resolution — and every read-only caller — is allowed to do. */
export interface EntityGraphReader {
  entities(): readonly Entity[];
  entity(key: string): Entity | undefined;
  /** The deterministic join key. One domain names at most one entity, by load-time invariant. */
  entityForDomain(domain: string): Entity | undefined;
  /**
   * Every link to a native id, WHATEVER its status. Status filtering is
   * resolution's job and is done in one place, so a second caller cannot
   * accidentally treat a `proposed` link as usable.
   */
  linksTo(system: LinkSystem, id: string): readonly EntityLinkRef[];
}

/** A link a scan found. It has no `status`: `propose` can only ever propose. */
export interface ProposedLink {
  system: LinkSystem;
  id: string;
  evidence: string;
  method: LinkMethod;
}

export interface EntityGraphStore extends EntityGraphReader {
  /**
   * Records a link as `proposed`. An already existing (system, id) link on that
   * entity is returned UNTOUCHED — a rescan must never overwrite a human's
   * decision, in either direction.
   */
  propose(entityKey: string, link: ProposedLink): EntityLink;
  /**
   * The only path that can make a link `confirmed`, and the only one that needs
   * a human's name. Everything else — reject, mark broken, un-confirm — goes
   * through here too, so one function owns the invariants.
   */
  setStatus(
    entityKey: string,
    system: LinkSystem,
    id: string,
    status: LinkStatus,
    by?: string,
  ): EntityLink;
}

interface Index {
  byKey: Map<string, Entity>;
  byDomain: Map<string, Entity>;
  byLink: Map<string, EntityLinkRef[]>;
}

function index(graph: EntityGraph): Index {
  const byKey = new Map<string, Entity>();
  const byDomain = new Map<string, Entity>();
  const byLink = new Map<string, EntityLinkRef[]>();
  for (const entity of graph.entities) {
    byKey.set(entity.key, entity);
    for (const domain of entity.domains) byDomain.set(domain, entity);
    for (const link of entity.links) {
      const key = linkKey(link.system, link.id);
      const refs = byLink.get(key) ?? [];
      refs.push({ entityKey: entity.key, link });
      byLink.set(key, refs);
    }
  }
  return { byKey, byDomain, byLink };
}

const EMPTY: readonly EntityLinkRef[] = [];

/** An in-memory reader over an already parsed graph — and the test seam. */
export function entityGraphReader(graph: EntityGraph): EntityGraphReader {
  const idx = index(graph);
  return {
    entities: (): readonly Entity[] => graph.entities,
    entity: (key: string): Entity | undefined => idx.byKey.get(key),
    entityForDomain: (domain: string): Entity | undefined =>
      idx.byDomain.get(domain.trim().toLowerCase()),
    linksTo: (system: LinkSystem, id: string): readonly EntityLinkRef[] =>
      idx.byLink.get(linkKey(system, id)) ?? EMPTY,
  };
}

const EMPTY_GRAPH: EntityGraph = { version: 1, entities: [] };

/**
 * A missing file is an empty graph, not an error: a deployment with no graph at
 * all must still mint native-only missions. The graph only ever ADDS systems —
 * it can never be a prerequisite for getting value out of the proxy.
 */
function readGraph(path: string): EntityGraph {
  if (!existsSync(path)) return EMPTY_GRAPH;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`entity graph ${path} is not valid JSON`);
  }
  return parseEntityGraph(parsed, `entity graph ${path}`);
}

/** Temp file beside the target, then rename: a reader sees one whole file. */
function writeGraph(path: string, graph: EntityGraph): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, serializeEntityGraph(graph), "utf8");
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone (the rename landed, or it was never created).
    }
    throw err;
  }
}

function requireEntity(graph: EntityGraph, key: string): Entity {
  const entity = graph.entities.find((e) => e.key === key);
  if (entity === undefined) throw new Error(`unknown entity: ${key}`);
  return entity;
}

function replace(graph: EntityGraph, entity: Entity): EntityGraph {
  return {
    version: graph.version,
    entities: graph.entities.map((e) => (e.key === entity.key ? entity : e)),
  };
}

function stamped(link: EntityLink, status: LinkStatus, by?: string): EntityLink {
  const next: EntityLink = { ...link, status };
  // Leaving `confirmed` drops the stamp, so a rejected or broken link never
  // reads — in a diff or in a log — as one somebody signed off.
  delete next.confirmedBy;
  delete next.confirmedAt;
  if (status !== "confirmed") return next;
  if (by === undefined || by.trim() === "") {
    throw new Error("confirming a link must name who confirmed it");
  }
  next.confirmedBy = by;
  next.confirmedAt = new Date().toISOString();
  return next;
}

/**
 * The file-backed store. Reads are served from the graph read at open — a proxy
 * must not stat a file per request, and an operator editing the graph under a
 * running proxy is making a policy change, which takes a restart.
 *
 * Writes re-read first: `missura scan` and a human's `missura review` run in
 * different processes, and a proposal appended by one must not be erased by the
 * other's rewrite. That narrows the window; it does not close it (same tradeoff
 * as `MissionStore.persist`, and the same answer: a single writer or a lock
 * file, neither of which is this milestone).
 */
export function openEntityGraph(path: string): EntityGraphStore {
  let graph = readGraph(path);
  let reader = entityGraphReader(graph);

  const commit = (next: EntityGraph): void => {
    writeGraph(path, next);
    graph = next;
    reader = entityGraphReader(next);
  };

  return {
    entities: (): readonly Entity[] => reader.entities(),
    entity: (key: string): Entity | undefined => reader.entity(key),
    entityForDomain: (domain: string): Entity | undefined =>
      reader.entityForDomain(domain),
    linksTo: (system: LinkSystem, id: string): readonly EntityLinkRef[] =>
      reader.linksTo(system, id),

    propose(entityKey: string, link: ProposedLink): EntityLink {
      const fresh = readGraph(path);
      const entity = requireEntity(fresh, entityKey);
      const held = entity.links.find(
        (l) => l.system === link.system && linkKey(l.system, l.id) === linkKey(link.system, link.id),
      );
      if (held !== undefined) return held;
      const proposed: EntityLink = { ...link, status: "proposed" };
      const next = replace(fresh, {
        ...entity,
        links: [...entity.links, proposed],
      });
      commit(next);
      return proposed;
    },

    setStatus(
      entityKey: string,
      system: LinkSystem,
      id: string,
      status: LinkStatus,
      by?: string,
    ): EntityLink {
      const fresh = readGraph(path);
      const entity = requireEntity(fresh, entityKey);
      const key = linkKey(system, id);
      const held = entity.links.find(
        (l) => l.system === system && linkKey(l.system, l.id) === key,
      );
      if (held === undefined) {
        throw new Error(`entity "${entityKey}": no ${system} link ${id}`);
      }
      const moved = stamped(held, status, by);
      const updated: Entity = {
        ...entity,
        links: entity.links.map((l) => (l === held ? moved : l)),
      };
      // Re-checked on the way in, not only at load: a confirmation is exactly
      // the move that can create the ambiguity the graph refuses to hold.
      assertSingleValued(updated);
      commit(replace(fresh, updated));
      return moved;
    },
  };
}
