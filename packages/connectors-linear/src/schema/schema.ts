/**
 * Read-only accessors over the committed `schema.json`. This is the runtime
 * side: no parsing, no SDK, no filesystem — the artifact is imported as data
 * and every lookup is an own-property lookup so a field named `constructor`
 * cannot borrow an answer from `Object.prototype`.
 */

import artifact from "./schema.json";

export interface FieldInfo {
  readonly type: string;
  readonly nullable: boolean;
  readonly list: boolean;
}

interface TypeEntry {
  readonly fields: Record<string, FieldInfo>;
  readonly excluded: Record<string, string>;
}

const TYPES: Record<string, TypeEntry> = artifact.types;
const LEAVES: ReadonlySet<string> = new Set<string>(artifact.leaves);

function entry(type: string): TypeEntry | undefined {
  return Object.hasOwn(TYPES, type) ? TYPES[type] : undefined;
}

/**
 * The type and nullability of `parentType.field`, or `undefined` — which the
 * callers must read as DENY. Undefined covers three cases on purpose: the type
 * is not in the artifact, the field is not on it, and the extractor refused to
 * map the field (see `excludedFields`).
 */
export function fieldInfo(parentType: string, field: string): FieldInfo | undefined {
  const type = entry(parentType);
  if (type === undefined) return undefined;
  return Object.hasOwn(type.fields, field) ? type.fields[field] : undefined;
}

/** True when the artifact carries the type — a leaf counts. */
export function knownType(type: string): boolean {
  return entry(type) !== undefined || LEAVES.has(type);
}

/** True for a scalar/enum: known, but with no fields to walk into. */
export function leafType(type: string): boolean {
  return LEAVES.has(type);
}

/** Every object type in the artifact, sorted. */
export function typeNames(): readonly string[] {
  return Object.keys(TYPES);
}

/** Every mapped field name of a type, sorted; empty for a leaf or an unknown. */
export function schemaFieldNames(type: string): readonly string[] {
  const found = entry(type);
  return found === undefined ? [] : Object.keys(found.fields);
}

/**
 * What the extractor saw but refused to map, and why. Kept reachable so a deny
 * can say "the connector does not model this field" instead of "no such field".
 */
export function excludedFields(type: string): Readonly<Record<string, string>> {
  return entry(type)?.excluded ?? {};
}

/** The `@linear/sdk` version the artifact was extracted from. */
export const SCHEMA_SDK_VERSION: string = artifact.sdkVersion;
