/**
 * Reading and writing the entity graph DOCUMENT.
 *
 * The file is two audiences at once: an engineer reviewing a diff in a PR, and
 * a scan that appends proposals unattended. So it is a plain object keyed by
 * entity key (stable diffs, no array reordering), every field is spelled out
 * rather than encoded, and it is written back pretty-printed with a trailing
 * newline.
 *
 * Everything here fails LOUD. A graph we cannot fully read throws before a
 * token exists — exactly as the flat map did — because the alternative is a
 * mission minted against a scope nobody could describe.
 */

import {
  ENTITY_GRAPH_VERSION,
  LINK_SYSTEMS,
  SINGLE_VALUED_SYSTEMS,
  type Entity,
  type EntityGraph,
  type EntityLink,
  type LinkMethod,
  type LinkStatus,
} from "./entity-graph";
import { parseGithubRepoScope } from "./github-scope";

const METHODS: readonly LinkMethod[] = ["deterministic", "inferred", "manual"];
const STATUSES: readonly LinkStatus[] = [
  "proposed",
  "confirmed",
  "rejected",
  "broken",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(where: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: "${field}" must be a non-empty string`);
  }
  return value;
}

function oneOf<T extends string>(
  where: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `${where}: "${field}" must be one of ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

/**
 * A domain is the join key, so it is normalized (DNS is case-insensitive) and
 * refused when it is anything but a hostname — a URL or an email address here
 * would silently never match.
 */
function readDomain(where: string, value: unknown): string {
  const raw = text(where, "domains", value).trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
    throw new Error(
      `${where}: "${raw}" is not a bare domain — no scheme, no path, no "@"`,
    );
  }
  return raw;
}

function readLink(where: string, value: unknown): EntityLink {
  if (!isRecord(value)) throw new Error(`${where}: every link must be an object`);
  const system = oneOf(where, "system", value.system, LINK_SYSTEMS);
  if (typeof value.id !== "string" || value.id === "") {
    throw new Error(
      `${where}: link "id" must be a string — quote it, even a numeric Zendesk id`,
    );
  }
  const id = value.id;
  if (system === "github") {
    try {
      parseGithubRepoScope(id);
    } catch (err) {
      throw new Error(
        `${where}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const at = `${where}: link ${system}:${id}`;
  const status = oneOf(at, "status", value.status, STATUSES);
  const link: EntityLink = {
    system,
    id,
    evidence: text(at, "evidence", value.evidence),
    method: oneOf(at, "method", value.method, METHODS),
    status,
  };
  // The stamp exists only while the link is confirmed: a rejected link that
  // still named a confirmer would read, in a diff, as one somebody signed off.
  if (status === "confirmed") {
    if (value.confirmedBy !== undefined) {
      link.confirmedBy = text(at, "confirmedBy", value.confirmedBy);
    }
    if (value.confirmedAt !== undefined) {
      link.confirmedAt = text(at, "confirmedAt", value.confirmedAt);
    }
  }
  return link;
}

/**
 * At most one CONFIRMED link per single-valued system. Two confirmed Linear
 * customers on one entity has no honest answer — resolution would have to pick
 * one — so it is refused where it is written, not where it is read.
 */
export function assertSingleValued(entity: Entity): void {
  for (const system of SINGLE_VALUED_SYSTEMS) {
    const ids = entity.links
      .filter((l) => l.system === system && l.status === "confirmed")
      .map((l) => l.id);
    if (ids.length > 1) {
      throw new Error(
        `entity "${entity.key}": two confirmed "${system}" links (${ids.join(", ")}) — one entity holds one ${system} id`,
      );
    }
  }
}

function readEntity(key: string, value: unknown): Entity {
  const where = `entity "${key}"`;
  if (!isRecord(value)) throw new Error(`${where}: must be an object`);
  if (!Array.isArray(value.domains)) {
    throw new Error(`${where}: "domains" must be an array of hostnames`);
  }
  if (!Array.isArray(value.links)) {
    throw new Error(`${where}: "links" must be an array`);
  }
  const entity: Entity = {
    key,
    displayName: text(where, "displayName", value.displayName),
    domains: value.domains.map((d: unknown) => readDomain(where, d)),
    links: value.links.map((l: unknown) => readLink(where, l)),
  };
  assertSingleValued(entity);
  return entity;
}

/** One domain, one entity. The join key cannot be ambiguous and still be a key. */
function assertDomainsUnique(entities: readonly Entity[]): void {
  const owner = new Map<string, string>();
  for (const entity of entities) {
    for (const domain of entity.domains) {
      const held = owner.get(domain);
      if (held !== undefined) {
        throw new Error(
          `domain "${domain}" is claimed by two entities: ${held} and ${entity.key}`,
        );
      }
      owner.set(domain, entity.key);
    }
  }
}

/** Recognises the pre-graph file so its error says what to do, not "malformed". */
function assertNotFlatMap(parsed: Record<string, unknown>, source: string): void {
  const flat = Object.values(parsed).some(
    (v) => isRecord(v) && ("linear.customer" in v || "github.repos" in v),
  );
  if (flat) {
    throw new Error(
      `${source} is not an entity graph: the flat "customer:x": {"linear.customer": …} shape is no longer supported — rewrite it as {"version": 1, "entities": {…}}`,
    );
  }
}

export function parseEntityGraph(parsed: unknown, source: string): EntityGraph {
  if (!isRecord(parsed)) {
    throw new Error(`${source}: an entity graph is a JSON object`);
  }
  assertNotFlatMap(parsed, source);
  if (parsed.version !== ENTITY_GRAPH_VERSION) {
    throw new Error(
      `${source}: "version" must be ${String(ENTITY_GRAPH_VERSION)}, got ${JSON.stringify(parsed.version)}`,
    );
  }
  if (!isRecord(parsed.entities)) {
    throw new Error(`${source}: "entities" must be an object of entity keys`);
  }
  const entities = Object.entries(parsed.entities).map(([key, value]) =>
    readEntity(key, value),
  );
  assertDomainsUnique(entities);
  return { version: ENTITY_GRAPH_VERSION, entities };
}

function serializeLink(link: EntityLink): Record<string, unknown> {
  const out: Record<string, unknown> = {
    system: link.system,
    id: link.id,
    evidence: link.evidence,
    method: link.method,
    status: link.status,
  };
  if (link.confirmedBy !== undefined) out.confirmedBy = link.confirmedBy;
  if (link.confirmedAt !== undefined) out.confirmedAt = link.confirmedAt;
  return out;
}

/**
 * Back to text. Whitelisted field by field and in a fixed order, so a value
 * that reached an in-memory object from anywhere else cannot ride into the file
 * — the same discipline `events.ts` applies to the decision log.
 */
export function serializeEntityGraph(graph: EntityGraph): string {
  const entities: Record<string, unknown> = {};
  for (const entity of graph.entities) {
    entities[entity.key] = {
      displayName: entity.displayName,
      domains: [...entity.domains],
      links: entity.links.map(serializeLink),
    };
  }
  return `${JSON.stringify({ version: graph.version, entities }, null, 2)}\n`;
}
