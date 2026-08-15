/**
 * PROVENANCE — the record of what a scope was built from, and of what it was
 * NOT built from.
 *
 * A wrong mapping has to be traceable after the fact. "This mission reached
 * that GitHub directory" is only auditable if the confirmed link it came
 * through is written down beside it; and "this mission ran narrow" is only
 * answerable if the links it declined to use are written down too. So both
 * halves travel together, on the mission record and on every decision event
 * the mission produces.
 *
 * Copied FIELD BY FIELD, the same discipline `events.ts` applies to the
 * decision log: a link object holds evidence text an operator wrote, and a
 * resolution object is built by callers who may attach anything to it. Nothing
 * rides into a log line because it happened to be on an object.
 */

import type {
  LinkUse,
  ScopeDegradation,
  ScopeResolution,
} from "./entity-resolve";

export interface ScopeProvenance {
  /** `native` ⇒ no entity was involved and no link was ever used. */
  via: "entity" | "native";
  entityKey?: string;
  links: readonly LinkUse[];
  degraded: readonly ScopeDegradation[];
}

export function redactLinkUse(use: LinkUse): LinkUse {
  return { system: use.system, id: use.id, status: use.status };
}

export function redactDegradation(d: ScopeDegradation): ScopeDegradation {
  return { system: d.system, reason: d.reason, id: d.id };
}

/** The whole account of a resolution, reduced to what may be written down. */
export function scopeProvenance(resolution: ScopeResolution): ScopeProvenance {
  const out: ScopeProvenance = {
    via: resolution.via,
    links: resolution.used.map(redactLinkUse),
    degraded: resolution.degraded.map(redactDegradation),
  };
  if (resolution.via === "entity") out.entityKey = resolution.entityKey;
  return out;
}
