import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assumption, type Assumption, type Verdict } from "./harness";
import type { IntrospectedType } from "./introspect";

/**
 * The pinned Linear schema, checked against the live one.
 *
 * `packages/connectors-linear/src/schema/schema.json` is extracted from the
 * SDK's TypeScript declarations — no network, no introspection — and the type
 * walk that decides every Linear request reads it as the truth. So it is an
 * assumption about the vendor in artifact form, and it is the one M2 got wrong:
 * a field the connector believes in and the vendor does not is not a bug that
 * shows up as a wrong answer, it is a request the vendor rejects outright.
 *
 * Three separate verdicts, not one, because they fail for different reasons and
 * cost different things:
 *   - a TYPE that no longer exists breaks every request that reaches it;
 *   - a FIELD that no longer exists breaks the requests that select it;
 *   - a NULLABILITY that moved changes what the connector is allowed to remove
 *     (`narrow-walk` refuses to strip a non-nullable field), so it is a
 *     compatibility fact, not a cosmetic one.
 *
 * What is NOT compared: the field's type NAME. The artifact records the SDK's
 * TypeScript spelling (`string`, `number`, `Date`) and the vendor answers in
 * GraphQL's (`String`, `Float`, `DateTime`); a mapping between the two would be
 * a table of our own guesses sitting in the middle of a check meant to have
 * none.
 */

export const SCHEMA_FILE = "packages/connectors-linear/src/schema/schema.json";

const SCHEMA_MODULE = "@missura/connectors-linear/src/schema/schema.json";

/** How many offending names an evidence line names before it summarizes. */
const SHOWN = 6;

export interface PinnedField {
  readonly nullable: boolean;
  readonly list: boolean;
}

export type PinnedSchema = Map<string, Map<string, PinnedField>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The committed artifact, read from disk rather than imported: what is under
 * test is the FILE the connector ships, and an import would let a bundler or a
 * stale build step answer for it.
 */
export function readPinnedSchema(): PinnedSchema {
  const path = createRequire(import.meta.url).resolve(SCHEMA_MODULE);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const out: PinnedSchema = new Map();
  if (!isRecord(parsed) || !isRecord(parsed.types)) return out;
  for (const [type, entry] of Object.entries(parsed.types)) {
    if (!isRecord(entry) || !isRecord(entry.fields)) continue;
    const fields = new Map<string, PinnedField>();
    for (const [field, info] of Object.entries(entry.fields)) {
      if (!isRecord(info)) continue;
      fields.set(field, {
        nullable: info.nullable === true,
        list: info.list === true,
      });
    }
    out.set(type, fields);
  }
  return out;
}

function summarize(items: readonly string[]): string {
  if (items.length <= SHOWN) return items.join(", ");
  return `${items.slice(0, SHOWN).join(", ")} … and ${String(items.length - SHOWN)} more`;
}

interface Sweep {
  missingTypes: string[];
  missingFields: string[];
  nullabilityMoved: string[];
  /** Types the live schema carried, so the counts below mean something. */
  checkedTypes: number;
  checkedFields: number;
}

/**
 * Compares the artifact against the live schema. A type the live schema does
 * not carry contributes ONE finding and its fields are not then reported one by
 * one — fifty field findings under one missing type would bury the fifty-first
 * that belongs to a type that does exist.
 */
export function sweep(
  pinned: PinnedSchema,
  live: Map<string, IntrospectedType>,
): Sweep {
  const result: Sweep = {
    missingTypes: [],
    missingFields: [],
    nullabilityMoved: [],
    checkedTypes: 0,
    checkedFields: 0,
  };
  for (const [type, fields] of pinned) {
    const actual = live.get(type);
    if (actual === undefined || actual.fields.size === 0) {
      result.missingTypes.push(type);
      continue;
    }
    result.checkedTypes += 1;
    for (const [field, info] of fields) {
      const liveField = actual.fields.get(field);
      if (liveField === undefined) {
        result.missingFields.push(`${type}.${field}`);
        continue;
      }
      result.checkedFields += 1;
      if (liveField.nullable !== info.nullable) {
        result.nullabilityMoved.push(
          `${type}.${field} (pinned ${info.nullable ? "nullable" : "non-null"}, live ${liveField.nullable ? "nullable" : "non-null"})`,
        );
      }
    }
  }
  return result;
}

function verdictOf(findings: readonly string[]): Verdict {
  return findings.length === 0 ? "HOLDS" : "BROKEN";
}

/**
 * The three verdicts, built from one sweep so they cannot disagree about what
 * the live schema said.
 */
export function schemaAssumptions(
  pinned: PinnedSchema,
  live: Map<string, IntrospectedType>,
  method: string,
): Assumption[] {
  const found = sweep(pinned, live);
  const base = { vendor: "linear" as const, encodedIn: SCHEMA_FILE };
  return [
    assumption(
      {
        ...base,
        id: "linear.schema.types-exist",
        claim: `every one of the ${String(pinned.size)} types the pinned schema records still exists in the live schema`,
      },
      verdictOf(found.missingTypes),
      found.missingTypes.length === 0
        ? `${method}: all ${String(found.checkedTypes)} types resolved and carry fields`
        : `${method}: the live schema has no fields for ${summarize(found.missingTypes)}`,
    ),
    assumption(
      {
        ...base,
        id: "linear.schema.fields-exist",
        claim:
          "every field the pinned schema records still exists on its type in the live schema",
      },
      verdictOf(found.missingFields),
      found.missingFields.length === 0
        ? `${method}: all ${String(found.checkedFields)} recorded fields resolved`
        : `${method}: the live schema no longer declares ${summarize(found.missingFields)}`,
    ),
    assumption(
      {
        ...base,
        id: "linear.schema.nullability",
        claim:
          "every field's nullability is the one the pinned schema recorded — the connector may only strip what the vendor declares nullable",
      },
      verdictOf(found.nullabilityMoved),
      found.nullabilityMoved.length === 0
        ? `${method}: ${String(found.checkedFields)} fields agree on nullability`
        : `${method}: ${summarize(found.nullabilityMoved)}`,
    ),
  ];
}
