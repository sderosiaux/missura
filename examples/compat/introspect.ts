/**
 * GraphQL introspection, read defensively.
 *
 * Introspection is the cheap way to ask a vendor what its schema says, and it
 * is the only way to ask it about a type nothing in a response happens to
 * mention. It is also a feature an API may switch off, so nothing here throws
 * on a missing field: an unreadable answer becomes `undefined`, and the caller
 * falls back to probing — and SAYS which of the two it used.
 *
 * The types below are the introspection reply narrowed by hand rather than
 * cast. A cast would make a schema that changed shape read as a schema that
 * agrees with us, which is the exact failure this suite exists to catch.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field's type, with the wrappers unwound: what a client must handle. */
export interface TypeRef {
  /** The named type at the bottom of the wrappers, or `undefined` if unreadable. */
  name: string | undefined;
  /** True when the OUTERMOST wrapper is not `NON_NULL` — i.e. it can be null. */
  nullable: boolean;
  list: boolean;
}

export interface IntrospectedType {
  name: string;
  kind: string;
  /** Output fields, by name. Empty for an input type. */
  fields: Map<string, TypeRef>;
  /** Input fields, by name. Empty for an output type. */
  inputFields: Map<string, TypeRef>;
}

/** The selection every type reference in this file is read out of. */
export const TYPE_REF_SELECTION =
  "kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }";

export function readTypeRef(value: unknown): TypeRef {
  let node: unknown = value;
  let nullable = true;
  let list = false;
  let outermost = true;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!isRecord(node)) break;
    const kind = node.kind;
    if (kind === "NON_NULL") {
      if (outermost) nullable = false;
      node = node.ofType;
      outermost = false;
      continue;
    }
    if (kind === "LIST") {
      list = true;
      node = node.ofType;
      outermost = false;
      continue;
    }
    return {
      name: typeof node.name === "string" ? node.name : undefined,
      nullable,
      list,
    };
  }
  return { name: undefined, nullable, list };
}

function readFields(value: unknown): Map<string, TypeRef> {
  const out = new Map<string, TypeRef>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    out.set(entry.name, readTypeRef(entry.type));
  }
  return out;
}

function readType(value: unknown): IntrospectedType | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  return {
    name: value.name,
    kind: typeof value.kind === "string" ? value.kind : "UNKNOWN",
    fields: readFields(value.fields),
    inputFields: readFields(value.inputFields),
  };
}

/**
 * The types an aliased introspection answer carried, by NAME — the aliases are
 * a transport detail (`t0:`, `t1:`) and nothing downstream should know them.
 *
 * `undefined` means the answer was not usable as introspection at all: no
 * `data` object, or an `errors` array beside it. An EMPTY map means the answer
 * was well-formed and simply named no type, which is a different fact and the
 * caller reports it differently.
 */
export function readIntrospection(
  body: string,
): Map<string, IntrospectedType> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) return undefined;
  const data = parsed.data;
  if (!isRecord(data)) return undefined;
  const out = new Map<string, IntrospectedType>();
  for (const value of Object.values(data)) {
    const type = readType(value);
    if (type !== undefined) out.set(type.name, type);
  }
  return out;
}

/** One aliased `__type(name:)` per name, so a sweep costs a single POST. */
export function introspectionQuery(
  names: readonly string[],
  selection: "fields" | "inputFields",
): string {
  const body = names
    .map((name, index) => {
      const escaped = JSON.stringify(name);
      return `  t${String(index)}: __type(name: ${escaped}) { name kind ${selection} { name type { ${TYPE_REF_SELECTION} } } }`;
    })
    .join("\n");
  return `query CompatIntrospection {\n${body}\n}`;
}

/** True when a GraphQL answer carries at least one error. */
export function hasGraphqlErrors(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return isRecord(parsed) && Array.isArray(parsed.errors) && parsed.errors.length > 0;
}

/**
 * A code an error's `extensions` may carry, when it is one: an enum-shaped
 * token and nothing else. That is the allow-list — a vendor error CODE is
 * vocabulary, a vendor error MESSAGE is prose that can quote a workspace, an
 * identifier or a query the tenant wrote.
 */
const ENUM_TOKEN = /^[A-Za-z0-9_.-]{1,40}$/;

function enumToken(value: unknown): string | undefined {
  return typeof value === "string" && ENUM_TOKEN.test(value) ? value : undefined;
}

/**
 * A GraphQL refusal as a DESCRIPTOR: how many errors, which `extensions` keys
 * they carry, and the enum-shaped codes among them.
 *
 * It used to be `errors[0].message.slice(0, 160)`, and that message travelled
 * into a committed report. Linear's own not-found reads `Entity not found:
 * Issue - Could not find referenced Issue.` and its validation errors quote the
 * document the caller sent — so the slice was a window onto a workspace, cut to
 * a fixed width. What a reader needs from it is which KIND of refusal it was,
 * and that is what the codes say.
 */
export function graphqlErrorShape(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return undefined;
  const first: unknown = parsed.errors[0];
  if (!isRecord(first)) return undefined;
  const extensions = isRecord(first.extensions) ? first.extensions : {};
  const keys = Object.keys(extensions).sort();
  const codes = [enumToken(extensions.code), enumToken(extensions.type)].filter(
    (code): code is string => code !== undefined,
  );
  const shape = `${String(parsed.errors.length)} GraphQL error(s), extensions {${keys.join(", ")}}`;
  return codes.length === 0 ? shape : `${shape} — ${codes.join(", ")}`;
}
