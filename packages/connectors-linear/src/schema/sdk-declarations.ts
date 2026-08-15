/**
 * Reads the `@linear/sdk` generated class declarations (`dist/index.d.mts`)
 * into a schema we can enforce against. DEV-TIME ONLY: nothing here runs in the
 * proxy — the committed `schema.json` is what ships.
 *
 * How each declaration shape maps to a GraphQL field name and nullability:
 *
 *   `boardOrder: number;`            → `boardOrder`, non-null leaf `number`
 *   `description?: string | null;`   → `description`, nullable leaf `string`
 *   `labelIds: string[];`            → `labelIds`, non-null LIST of `string`
 *   `syncedWith?: X[] | null;`       → `syncedWith`, nullable LIST of `X`
 *   `reactionData: Scalars["JSONObject"];` → leaf `JSONObject`
 *   `private _team;` + `get team(): LinearFetch<Team> | undefined;`
 *                                    → `team`, NON-NULL single `Team`
 *   `private _assignee?;` + `get assignee(): LinearFetch<User> | undefined;`
 *                                    → `assignee`, NULLABLE single `User`
 *   `comments(variables?: Omit<Issue_CommentsQueryVariables, "id">):
 *        LinearFetch<CommentConnection>;`
 *                                    → `comments`, non-null `CommentConnection`
 *   `declare class IssueConnection extends Connection<Issue>`
 *                                    → `nodes: [Issue!]!`, `pageInfo: PageInfo!`
 *
 * The relation getters ALWAYS say `| undefined` (the SDK returns undefined when
 * the id is missing), so the getter is useless for nullability. The private
 * `_relation?` field is not: the SDK codegen marks it optional exactly when the
 * vendor field is nullable. That is the signal used here.
 *
 * Fail closed: a member whose shape is not in the table above is EXCLUDED with
 * a reason instead of guessed at. An excluded field is an unknown field, and an
 * unknown field is a deny.
 */

export interface SdkFieldInfo {
  readonly type: string;
  readonly nullable: boolean;
  readonly list: boolean;
}

/** Why a declared member is not a queryable field. */
export type ExclusionReason =
  /** `get teamId()` is `this._team?.id` in the SDK — derived, not a vendor field. */
  | "synthesized-id-getter"
  /** `get organization()` issues its own root query; it reads no parent data. */
  | "unbacked-getter"
  /** A type the parser cannot name (indexed access, union, `Record<…>`). */
  | "unmapped-type"
  /** A mutation, or any method that is not a plain connection read. */
  | "non-query-method";

export interface SdkTypeInfo {
  readonly fields: Readonly<Record<string, SdkFieldInfo>>;
  readonly excluded: Readonly<Record<string, ExclusionReason>>;
}

export interface SdkSchema {
  readonly types: Readonly<Record<string, SdkTypeInfo>>;
  /** Every non-class type name referenced by an extracted field: scalars, enums. */
  readonly leaves: readonly string[];
}

interface RawClass {
  readonly name: string;
  readonly extendsClause: string;
  readonly members: string[];
}

const CLASS_HEADER = /^declare class (\w+)(?: extends ([^{]+?))?\s*\{/;
const PRIVATE_RELATION = /^private _(\w+)(\?)?;$/;
const PROPERTY = /^(\w+)(\?)?: (.+);$/;
const GETTER = /^get (\w+)\(\): (.+);$/;
const METHOD = /^(\w+)\((.*)\): (.+);$/;
const RELATION_RETURN = /^LinearFetch<(\w+)> \| undefined$/;
const CONNECTION_RETURN = /^LinearFetch<(\w+Connection)>$/;
const CONNECTION_BASE = /^Connection<(\w+)>$/;
const CUSTOM_SCALAR = /^Scalars\["(\w+)"\]$/;
/** `variables?: Omit<Team_IssuesQueryVariables, "id">` and its un-omitted form. */
const QUERY_VARIABLES = /^variables\?: (?:Omit<)?\w*QueryVariables[,>]?/;
const BARE_NAME = /^\w+$/;

function splitClasses(source: string): Map<string, RawClass> {
  const classes = new Map<string, RawClass>();
  let current: RawClass | undefined;
  for (const line of source.split("\n")) {
    const header = CLASS_HEADER.exec(line);
    if (header?.[1] !== undefined) {
      current = {
        name: header[1],
        extendsClause: (header[2] ?? "").trim(),
        members: [],
      };
      classes.set(current.name, current);
      continue;
    }
    if (line === "}") {
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const member = line.trim();
    if (member === "" || member.startsWith("/*") || member.startsWith("*")) continue;
    current.members.push(member);
  }
  return classes;
}

/** `X[]` → list of X; `Scalars["Y"]` → Y; anything not a bare name → unnamed. */
function namedType(raw: string): { name: string; list: boolean } | undefined {
  let text = raw.trim();
  let list = false;
  if (text.endsWith("[]")) {
    list = true;
    text = text.slice(0, -2);
  }
  const scalar = CUSTOM_SCALAR.exec(text);
  if (scalar?.[1] !== undefined) return { name: scalar[1], list };
  return BARE_NAME.test(text) ? { name: text, list } : undefined;
}

function privateRelations(members: readonly string[]): Map<string, boolean> {
  const relations = new Map<string, boolean>();
  for (const member of members) {
    const match = PRIVATE_RELATION.exec(member);
    if (match?.[1] !== undefined) relations.set(match[1], match[2] === "?");
  }
  return relations;
}

interface Accumulator {
  fields: Record<string, SdkFieldInfo>;
  excluded: Record<string, ExclusionReason>;
}

function readProperty(name: string, optional: boolean, declared: string): SdkFieldInfo | undefined {
  let raw = declared;
  let nullable = optional;
  if (raw.endsWith(" | null")) {
    raw = raw.slice(0, -" | null".length);
    nullable = true;
  }
  const type = namedType(raw);
  return type === undefined
    ? undefined
    : { type: type.name, nullable, list: type.list };
}

function readGetter(
  name: string,
  returns: string,
  relations: Map<string, boolean>,
): SdkFieldInfo | ExclusionReason {
  const relation = RELATION_RETURN.exec(returns);
  if (relation?.[1] === undefined) {
    // `get teamId(): string | undefined` next to a `_team` private is the SDK's
    // derived id; anything else is a root query in disguise.
    const base = name.endsWith("Id") ? name.slice(0, -2) : undefined;
    return base !== undefined && relations.has(base)
      ? "synthesized-id-getter"
      : "unbacked-getter";
  }
  const nullable = relations.get(name);
  if (nullable === undefined) return "unbacked-getter";
  return { type: relation[1], nullable, list: false };
}

function readMethod(params: string, returns: string): SdkFieldInfo | undefined {
  const connection = CONNECTION_RETURN.exec(returns);
  if (connection?.[1] === undefined) return undefined;
  // A mutation takes `input:` or `*MutationVariables`; a read takes nothing or
  // `*QueryVariables`. Both checks must pass — `archive(variables?:
  // Omit<ArchiveIssueMutationVariables, "id">)` returns a payload, not a
  // connection, but the pairing is what makes this safe rather than lucky.
  if (params !== "" && !QUERY_VARIABLES.test(params)) return undefined;
  return { type: connection[1], nullable: false, list: false };
}

function readMembers(raw: RawClass): Accumulator {
  const relations = privateRelations(raw.members);
  const acc: Accumulator = { fields: {}, excluded: {} };
  const base = CONNECTION_BASE.exec(raw.extendsClause);
  if (base?.[1] !== undefined) {
    acc.fields.nodes = { type: base[1], nullable: false, list: true };
    acc.fields.pageInfo = { type: "PageInfo", nullable: false, list: false };
  }
  for (const member of raw.members) {
    if (member.startsWith("private ") || member.startsWith("constructor(")) continue;
    const property = PROPERTY.exec(member);
    if (property?.[1] !== undefined && property[3] !== undefined) {
      const field = readProperty(property[1], property[2] === "?", property[3]);
      if (field === undefined) acc.excluded[property[1]] = "unmapped-type";
      else acc.fields[property[1]] = field;
      continue;
    }
    const getter = GETTER.exec(member);
    if (getter?.[1] !== undefined && getter[2] !== undefined) {
      const outcome = readGetter(getter[1], getter[2], relations);
      if (typeof outcome === "string") acc.excluded[getter[1]] = outcome;
      else acc.fields[getter[1]] = outcome;
      continue;
    }
    const method = METHOD.exec(member);
    if (method?.[1] !== undefined && method[2] !== undefined && method[3] !== undefined) {
      const field = readMethod(method[2], method[3]);
      if (field === undefined) acc.excluded[method[1]] = "non-query-method";
      else acc.fields[method[1]] = field;
      continue;
    }
    acc.excluded[member] = "unmapped-type";
  }
  return acc;
}

function sortedRecord<T>(entries: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(entries).sort()) {
    const value = entries[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

/**
 * Extracts `seeds` and nothing else. A type absent from `seeds` never reaches
 * the artifact, so `typeClass` reports it unknown and the walk denies it — the
 * curated classification, not the SDK's surface, decides what is reachable.
 */
export function parseSdkDeclarations(
  source: string,
  seeds: readonly string[],
): SdkSchema {
  const classes = splitClasses(source);
  const types: Record<string, SdkTypeInfo> = {};
  const leaves = new Set<string>();
  for (const name of [...seeds].sort()) {
    const raw = classes.get(name);
    if (raw === undefined) continue;
    const { fields, excluded } = readMembers(raw);
    types[name] = { fields: sortedRecord(fields), excluded: sortedRecord(excluded) };
  }
  for (const type of Object.values(types)) {
    for (const field of Object.values(type.fields)) {
      if (!classes.has(field.type)) leaves.add(field.type);
    }
  }
  return { types: sortedRecord(types), leaves: [...leaves].sort() };
}
