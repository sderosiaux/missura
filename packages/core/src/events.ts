import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LinkSystem } from "./entity-graph";
import type { LinkUse, ScopeDegradation } from "./entity-resolve";
import { redactDegradation, redactLinkUse } from "./scope-provenance";

/**
 * The systems the data plane speaks. Aliased to the entity graph's `LinkSystem`
 * rather than re-declared: a link to a system the proxy cannot enforce, or a
 * provider the graph cannot describe, would be a divergence nobody notices
 * until a mission is minted against it.
 */
export type Provider = LinkSystem;
export type Decision = "allow" | "deny";

export interface DecisionEvent {
  ts: string;
  provider: Provider;
  operation: string;
  action: string;
  decision: Decision;
  reason: string;
  missionId: string;
  latencyMs: number;
  /** Provenance, from the mission claims — who asked and what for. */
  actor?: string;
  purpose?: string;
  /** `trace-id` of an inbound W3C `traceparent`, when the agent sent a valid one. */
  traceId?: string;
  /**
   * How many objects the response FILTER removed (dropped from a list or
   * nulled). Absent when no filter plan ran; `0` when one ran and found the
   * whole answer authorized — the difference is what makes the log auditable.
   */
  objectsRemoved?: number;
  /**
   * How the mission's scope was built (`entity-resolve.ts`). `native` means no
   * entity was involved, so the graph widened nothing.
   */
  scopeVia?: "entity" | "native";
  /** The entity the scope was widened through, when there was one. */
  scopeEntity?: string;
  /** The confirmed links the scope was built from — a wrong mapping's trail. */
  scopeLinks?: readonly LinkUse[];
  /**
   * What the graph knew about and did NOT put in scope, and why. This is what
   * makes "the mission ran narrow because the Linear link is only proposed" a
   * query rather than an investigation.
   */
  scopeDegraded?: readonly ScopeDegradation[];
}

/**
 * The only fields ever serialized. Redaction by construction: anything the
 * caller attaches beyond this list (tokens, headers, bodies) is dropped, so a
 * secret cannot leak into the decision log by accident.
 */
const SERIALIZED_FIELDS = [
  "ts",
  "provider",
  "operation",
  "action",
  "decision",
  "reason",
  "missionId",
  "latencyMs",
  "actor",
  "purpose",
  "traceId",
  "objectsRemoved",
  "scopeVia",
  "scopeEntity",
] as const satisfies readonly (keyof DecisionEvent)[];

/**
 * Copies the whitelist only, and only the fields that are actually set: an
 * absent provenance field leaves no empty key behind in the log.
 *
 * The two array fields are rebuilt element by element rather than copied by
 * reference: a whitelist that stops at the top level is not one, and a link
 * object carries operator-written evidence text that has no business in a log.
 */
function redact(ev: DecisionEvent): DecisionEvent {
  const out: Partial<Record<keyof DecisionEvent, unknown>> = {};
  for (const field of SERIALIZED_FIELDS) {
    if (ev[field] !== undefined) out[field] = ev[field];
  }
  if (ev.scopeLinks !== undefined) out.scopeLinks = ev.scopeLinks.map(redactLinkUse);
  if (ev.scopeDegraded !== undefined) {
    out.scopeDegraded = ev.scopeDegraded.map(redactDegradation);
  }
  return out as DecisionEvent;
}

/** `2026-08-14T10:00:00.000Z` → `2026-08-14`, falling back to today on a bad ts. */
function dayOf(ts: string): string {
  const parsed = new Date(ts);
  const iso = Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString();
  return iso.slice(0, 10);
}

/** Appends one redacted JSONL record to `<dir>/<YYYY-MM-DD>.jsonl`. */
export function appendEvent(dir: string, ev: DecisionEvent): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(redact(ev))}\n`;
  appendFileSync(join(dir, `${dayOf(ev.ts)}.jsonl`), line, { mode: 0o600 });
}

/** Human-readable one-liner for the CLI, built only from whitelisted fields. */
export function formatEventLine(ev: DecisionEvent): string {
  const e = redact(ev);
  const decision = e.decision.toUpperCase().padEnd(5, " ");
  const provider = e.provider.padEnd(6, " ");
  const latency = `${String(e.latencyMs)}ms`;
  return `${decision}  ${provider}  ${e.operation}  ${e.action}  ${latency}  ${e.reason}`;
}
