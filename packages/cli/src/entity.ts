import {
  assertEntityKey,
  isWriteEffect,
  LINK_SYSTEMS,
  linkKey,
  openEntityGraph,
  parseGithubRepoScope,
  type EntityGraphStore,
  type LinkSystem,
} from "@missura/core";
import { ALL_OPERATIONS } from "@missura/proxy";
import { connectedSystems, deploymentFeasibility, openVault } from "./deployment";
import { showLines } from "./entity-show";
import type { CliIo } from "./io";
import { resolveHome } from "./paths";

/**
 * `missura entity <show|confirm|link>` — the operator's side of the graph.
 *
 * `show` is the M9 surface: what this entity can run on this deployment, and
 * for everything else the one cause and the command that closes it. `confirm`
 * and `link` exist because `show` names them — a gap whose remediation is a
 * command nobody built would be the operator's hallucinated workaround. They
 * are the smallest real versions: one link, one status, one human's name.
 */
export interface EntityOptions {
  json: boolean;
  /** Who is signing a link off: `--actor`, or the shell user. Recorded on the link. */
  actor: string;
  entitiesPath?: string;
}

const SUBCOMMANDS = ["show", "confirm", "link"] as const;

function requireKey(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("missura entity needs an entity key — customer:adeo, project:atlas");
  }
  return assertEntityKey(value.trim());
}

function requireSystem(value: string | undefined): LinkSystem {
  if (value === undefined || !(LINK_SYSTEMS as readonly string[]).includes(value)) {
    throw new Error(`system must be one of ${LINK_SYSTEMS.join(", ")}`);
  }
  return value as LinkSystem;
}

/**
 * A GitHub id is refused by shape BEFORE it is written: the graph loader
 * would refuse the whole file on the next open, which is a worse place to
 * learn about a typo than here. Linear and Zendesk ids are opaque.
 */
function requireId(system: LinkSystem, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`missura entity link <key> <system> <id> — the id in ${system}'s own spelling`);
  }
  const id = value.trim();
  if (system === "github") parseGithubRepoScope(id);
  return id;
}

/** Every write the catalogue holds: the operator's "what could I grant" question. */
function everyWrite(): readonly string[] {
  return ALL_OPERATIONS.filter((op) => isWriteEffect(op.effect)).map((op) => op.name);
}

function open(io: CliIo, options: EntityOptions): EntityGraphStore {
  return openEntityGraph(options.entitiesPath ?? resolveHome(io.env).entitiesPath);
}

function show(io: CliIo, args: readonly string[], options: EntityOptions): number {
  const key = requireKey(args[0]);
  const graph = open(io, options);
  const entity = graph.entity(key);
  if (entity === undefined) throw new Error(`unknown entity: ${key}`);
  const connected = connectedSystems(openVault(resolveHome(io.env)));
  const report = deploymentFeasibility(graph, connected)(key, everyWrite());
  if (options.json) {
    io.stdout(
      JSON.stringify({
        entity: entity.key,
        displayName: entity.displayName,
        domains: entity.domains,
        links: entity.links,
        connected,
        operations: report.operations,
      }),
    );
    return 0;
  }
  for (const line of showLines(entity, report)) io.stdout(line);
  return 0;
}

/**
 * The link to act on, when the command names no id: the entity's one link on
 * that system. Two or more is an ambiguity the operator has to resolve by
 * naming one — guessing would confirm somebody else's id.
 */
function linkOn(graph: EntityGraphStore, key: string, system: LinkSystem, id: string | undefined): string {
  const entity = graph.entity(key);
  if (entity === undefined) throw new Error(`unknown entity: ${key}`);
  const held = entity.links.filter((link) => link.system === system);
  if (id !== undefined) {
    const match = held.find((link) => linkKey(system, link.id) === linkKey(system, id));
    if (match === undefined) throw new Error(`${key} has no ${system} link ${id}`);
    return match.id;
  }
  const [only, ...more] = held;
  if (only === undefined) {
    throw new Error(
      `${key} has no ${system} link — add one: missura entity link ${key} ${system} <id>`,
    );
  }
  if (more.length > 0) {
    throw new Error(
      `${key} has ${String(held.length)} ${system} links — name one: ${held.map((l) => l.id).join(", ")}`,
    );
  }
  return only.id;
}

function confirm(io: CliIo, args: readonly string[], options: EntityOptions): number {
  const key = requireKey(args[0]);
  const system = requireSystem(args[1]);
  const graph = open(io, options);
  const id = linkOn(graph, key, system, args[2]);
  graph.setStatus(key, system, id, "confirmed", options.actor);
  io.stdout(`confirmed ${system} ${id} on ${key} (by ${options.actor})`);
  return 0;
}

/**
 * An operator typing an id by hand IS a human signing it off: the link is
 * recorded `manual` and confirmed in one step. On an id the entity already
 * holds, `propose` leaves the existing link alone and the confirmation
 * applies to it — so `link` on a proposed id is `confirm`, spelled longer.
 *
 * Not on a REJECTED one. A human said no to that id; overriding a decision
 * must be a decision, so `link` refuses and names the command that is one.
 */
function link(io: CliIo, args: readonly string[], options: EntityOptions): number {
  const key = requireKey(args[0]);
  const system = requireSystem(args[1]);
  const id = requireId(system, args[2]);
  const graph = open(io, options);
  const held = graph
    .entity(key)
    ?.links.find((l) => l.system === system && linkKey(system, l.id) === linkKey(system, id));
  if (held?.status === "rejected") {
    throw new Error(
      `${key} ${system} ${id} is rejected — to override that explicitly: missura entity confirm ${key} ${system} ${id}`,
    );
  }
  graph.propose(key, { system, id, evidence: `linked by ${options.actor}`, method: "manual" });
  graph.setStatus(key, system, id, "confirmed", options.actor);
  io.stdout(`linked ${system} ${id} to ${key}, confirmed (by ${options.actor})`);
  return 0;
}

export function entityCommand(
  io: CliIo,
  sub: string | undefined,
  args: readonly string[],
  options: EntityOptions,
): number {
  switch (sub) {
    case "show":
      return show(io, args, options);
    case "confirm":
      return confirm(io, args, options);
    case "link":
      return link(io, args, options);
    default:
      throw new Error(
        `missura entity <${SUBCOMMANDS.join("|")}> — ${sub === undefined ? "no subcommand given" : `unknown subcommand: ${sub}`}`,
      );
  }
}
