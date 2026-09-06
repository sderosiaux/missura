import type { LinkStatus, LinkSystem } from "./entity-graph";
import type { EntityGraphReader } from "./entity-graph-store";
import {
  resolveScopeFromGraph,
  type DegradeReason,
  type EntityScopeResolution,
} from "./entity-resolve";
import { gapRemediation } from "./feasibility-text";
import { connectionsFor } from "./missions";
import {
  operationAllowed,
  OperationGrantError,
  operationsFor,
  scopeSatisfies,
  type Grant,
  type Operation,
  type OperationEffect,
  type OperationListing,
} from "./operation";
import type { DenialCode } from "./remediation-types";
import type { MissionClaims } from "./token";

/**
 * THE GAP REPORT (M9). When an operation is not possible for an entity, the
 * answer is not "no" — it is the ONE thing standing in the way, and the step
 * that removes it. Computed from two things that already exist, the operation
 * catalogue and the entity graph, and from nothing else: no model, no guess.
 *
 * A gap has exactly one cause, resolved in this order and stopping at the
 * first that holds:
 *
 *   1. `system_not_connected` — the deployment has no connector for it. Nothing
 *      about the graph matters until it does, so this comes first.
 *   2. `no_link`              — the entity has no link to that system at all.
 *   3. `link_not_confirmed`   — a link exists and a human has not signed it off
 *                               (or said no, or the vendor lost the id). The
 *                               status it actually has travels with the gap.
 *   4. `not_granted`          — everything is in place; the mission's `allow`
 *                               does not name this write.
 *
 * The order is the order of the fixes: connect, then link, then confirm, then
 * grant. Reporting the first cause only is deliberate — a gap is a next step,
 * not a list of everything wrong, and the later causes are unknowable until
 * the earlier ones are closed (a link's status says nothing on a system the
 * proxy cannot reach).
 */
export type GapCause =
  | "system_not_connected"
  | "no_link"
  | "link_not_confirmed"
  | "not_granted";

/** A link that does not widen: every status but `confirmed`. */
export type UnconfirmedStatus = Exclude<LinkStatus, "confirmed">;

interface OperationBase {
  name: string;
  effect: OperationEffect;
  system: LinkSystem;
}

export interface PossibleOperation extends OperationBase {
  possible: true;
}

export type GapDetail =
  | { cause: "system_not_connected" }
  | { cause: "no_link" }
  | { cause: "link_not_confirmed"; status: UnconfirmedStatus }
  | { cause: "not_granted" };

/** The operator's view of one gap: system, status and the command that closes it. */
export type OperationGap = OperationBase & {
  possible: false;
  remediation: string;
} & GapDetail;

export type OperationFeasibility = PossibleOperation | OperationGap;

export interface FeasibilityReport {
  entity: string;
  /** Catalogue order, every operation: possible or its gap. */
  operations: readonly OperationFeasibility[];
}

export interface FeasibilityInput {
  reader: EntityGraphReader;
  /** The entity's whole key. Unknown to the graph, this throws. */
  entity: string;
  /**
   * EVERY operation the product knows, not only the ones this deployment
   * serves: an operation on an unconnected system is the first gap, and a
   * catalogue that omitted it could only answer "unknown".
   */
  catalogue: readonly Operation[];
  /** The systems this deployment has a connector for. */
  connected: readonly LinkSystem[];
  /** The write names the mission would be minted with. Reads need none. */
  allow: readonly string[];
}

const READ_VERBS: readonly string[] = ["read", "search"];

/** By how fixable: a proposed link needs one yes; the others need a new id. */
const STATUS_PREFERENCE: readonly UnconfirmedStatus[] = ["proposed", "broken", "rejected"];

function unconfirmedStatus(
  reader: EntityGraphReader,
  entity: string,
  system: LinkSystem,
): UnconfirmedStatus | undefined {
  const statuses = (reader.entity(entity)?.links ?? [])
    .filter((link) => link.system === system)
    .map((link) => link.status);
  return STATUS_PREFERENCE.find((status) => statuses.includes(status));
}

function gapFor(
  op: Operation,
  input: FeasibilityInput,
  resolution: EntityScopeResolution,
): OperationGap {
  const base = { name: op.name, effect: op.effect, system: op.connector, possible: false as const };
  const detail = gapDetail(op, input, resolution);
  return { ...base, ...detail, remediation: gapRemediation({ ...base, ...detail }, input.entity) };
}

function gapDetail(
  op: Operation,
  input: FeasibilityInput,
  resolution: EntityScopeResolution,
): GapDetail {
  if (!input.connected.includes(op.connector)) return { cause: "system_not_connected" };
  // The same question the executor asks before it plans: does the resolved
  // scope hold what the operation needs. Absent here means the graph gave the
  // system nothing usable — and which of the two that is, the links say.
  if (!scopeSatisfies(resolution.scope, op.needs)) {
    const status = unconfirmedStatus(input.reader, input.entity, op.connector);
    return status === undefined ? { cause: "no_link" } : { cause: "link_not_confirmed", status };
  }
  return { cause: "not_granted" };
}

/**
 * `operationsFor` on the mission this entity WOULD get — the graph's
 * connections, limited to what the deployment serves, under the read verbs
 * plus the requested names — and a gap for every catalogue operation it
 * leaves out. One function, one shape, for every surface that asks.
 */
export function feasibilityReport(input: FeasibilityInput): FeasibilityReport {
  const resolution = resolveScopeFromGraph(input.reader, { kind: "entity", key: input.entity });
  if (resolution.via !== "entity") throw new Error(`unknown entity: ${input.entity}`);
  const grant: Grant = {
    connections: connectionsFor(resolution.scope).filter((system) =>
      (input.connected as readonly string[]).includes(system),
    ),
    allow: [...READ_VERBS, ...input.allow],
  };
  const possible = new Set(operationsFor(grant, input.catalogue).map((op) => op.name));
  return {
    entity: input.entity,
    operations: input.catalogue.map((op) =>
      possible.has(op.name)
        ? { name: op.name, effect: op.effect, system: op.connector, possible: true }
        : gapFor(op, input, resolution),
    ),
  };
}

/** A name-grant refused by the gap it hits: the operator's next step, as the error. */
export class OperationGapError extends OperationGrantError {
  readonly gap: OperationGap;
  constructor(entity: string, gap: OperationGap) {
    super(
      `cannot grant ${gap.name} for ${entity}: ${gap.cause} (${gap.system}) — ${gap.remediation}`,
    );
    this.name = "OperationGapError";
    this.gap = gap;
  }
}

/**
 * The mint's question: may these names be granted on this entity? Throws the
 * FIRST gap among them. A name the report does not hold is left alone — that
 * refusal belongs to the store, against its own catalogue, and this one must
 * not turn "unknown operation" into a gap on a system it never named.
 */
export function assertGrantable(report: FeasibilityReport, names: readonly string[]): void {
  for (const name of names) {
    const entry = report.operations.find((op) => op.name === name);
    if (entry !== undefined && !entry.possible) throw new OperationGapError(report.entity, entry);
  }
}

/**
 * What the agent may be told about a gap: `not_granted`, or the reason class
 * its own token already carries for that system. Never a link status, never
 * an id, never a system it was not told about.
 */
export type AgentGapCause = "not_granted" | DegradeReason;

export type AgentOperationFeasibility =
  | (OperationListing & { possible: true })
  | (OperationListing & { possible: false; cause: AgentGapCause });

type AgentClaims = Pick<MissionClaims, "connections" | "degraded">;

/** The reason the token itself gives for leaving `system` out, if it gives one. */
export function degradationReason(
  claims: AgentClaims,
  system: LinkSystem,
): DegradeReason | undefined {
  return claims.degraded.find((d) => d.system === system)?.reason;
}

/**
 * THE AGENT PROJECTION of a report, decided from the claims where the claims
 * can decide: the report supplies the catalogue's shape, the token supplies
 * what the agent knows. An operation on a system that is neither in the
 * mission nor degraded on it is absent, not marked — naming it would name
 * the system.
 */
export function agentFeasibility(
  report: FeasibilityReport,
  claims: Grant & AgentClaims,
): readonly AgentOperationFeasibility[] {
  const out: AgentOperationFeasibility[] = [];
  for (const entry of report.operations) {
    // A gap the token cannot explain in its own words — no connector here, no
    // link at all — is not a gap the agent can be handed a reason for.
    if (!entry.possible && entry.cause !== "not_granted" && entry.cause !== "link_not_confirmed") {
      continue;
    }
    const listing: OperationListing = { name: entry.name, effect: entry.effect };
    if (claims.connections.includes(entry.system)) {
      out.push(
        entry.possible && operationAllowed(claims, listing)
          ? { ...listing, possible: true }
          : { ...listing, possible: false, cause: "not_granted" },
      );
      continue;
    }
    const reason = degradationReason(claims, entry.system);
    if (reason !== undefined) out.push({ ...listing, possible: false, cause: reason });
  }
  return out;
}

/**
 * The same projection, for a refusal: what the `missura` block may add as
 * `cause`. An action refusal is `not_granted`; a connection refusal is the
 * token's own reason for that system, when it holds one; anything else adds
 * nothing.
 */
export function agentCause(
  code: DenialCode,
  system: LinkSystem,
  claims: AgentClaims | undefined,
): AgentGapCause | undefined {
  if (code === "missura_action_not_allowed") return "not_granted";
  if (code === "missura_connection_not_in_mission" && claims !== undefined) {
    return degradationReason(claims, system);
  }
  return undefined;
}
