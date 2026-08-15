import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Provider = "linear" | "github";
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
] as const satisfies readonly (keyof DecisionEvent)[];

/**
 * Copies the whitelist only, and only the fields that are actually set: an
 * absent provenance field leaves no empty key behind in the log.
 */
function redact(ev: DecisionEvent): DecisionEvent {
  const out: Partial<Record<keyof DecisionEvent, unknown>> = {};
  for (const field of SERIALIZED_FIELDS) {
    if (ev[field] !== undefined) out[field] = ev[field];
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
