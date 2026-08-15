/**
 * Response SHAPE, and the difference between two of them.
 *
 * Half B compares a vendor's own answer against the one missura served. Most
 * of what differs is the product working: objects removed, a page shortened, a
 * vendor pagination position taken back. None of that breaks a typed SDK
 * consumer. What breaks one is a FIELD that stopped existing, or one whose type
 * changed — a non-nullable relation come back `null`, an object become a
 * string.
 *
 * So a body is flattened to `path → set of kinds`, with every array index
 * collapsed to `*`. Two pages of different lengths then produce the same paths,
 * and length is compared separately, as a count. That collapse is the whole
 * idea: it makes "fewer objects" invisible and "fewer fields" loud.
 */

export type ShapeKind =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "array"
  | "object";

/** Every path a body reaches, and every kind that path produced. */
export type Shape = Map<string, Set<ShapeKind>>;

function kindOf(value: unknown): ShapeKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "boolean") return "boolean";
  if (type === "number") return "number";
  if (type === "string") return "string";
  return "object";
}

function record(shape: Shape, path: string, kind: ShapeKind): void {
  const known = shape.get(path);
  if (known === undefined) shape.set(path, new Set([kind]));
  else known.add(kind);
}

function walk(shape: Shape, path: string, value: unknown): void {
  const kind = kindOf(value);
  record(shape, path, kind);
  if (kind === "array") {
    for (const element of value as unknown[]) {
      walk(shape, path === "" ? "*" : `${path}.*`, element);
    }
    return;
  }
  if (kind !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    walk(shape, path === "" ? key : `${path}.${key}`, child);
  }
}

/** The body flattened. The root itself is the empty path, so `null` has a kind. */
export function shapeOf(value: unknown): Shape {
  const shape: Shape = new Map();
  walk(shape, "", value);
  return shape;
}

/** How many elements a collapsed array path held, summed across its parents. */
export function arrayLengths(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (path: string, node: unknown): void => {
    if (Array.isArray(node)) {
      const key = path === "" ? "*" : `${path}.*`;
      counts.set(key, (counts.get(key) ?? 0) + node.length);
      for (const element of node) visit(key, element);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
      visit(path === "" ? name : `${path}.${name}`, child);
    }
  };
  visit("", value);
  return counts;
}

export interface ShapeEntry {
  path: string;
  kinds: ShapeKind[];
}

export interface Retyped {
  path: string;
  /** The kinds the vendor's own answer produced at this path. */
  direct: ShapeKind[];
  /** The kind the proxied answer introduced, which the vendor never sent. */
  proxied: ShapeKind;
}

export interface LengthChange {
  path: string;
  direct: number;
  proxied: number;
}

export interface ShapeDiff {
  /** Present in the vendor's answer, absent from ours — and not merely dropped. */
  missing: ShapeEntry[];
  /** Present in ours, absent from the vendor's. */
  added: ShapeEntry[];
  retyped: Retyped[];
  shrunk: LengthChange[];
  grew: LengthChange[];
}

/** True when some ancestor `*` of this path came back shorter. */
function underShrunkList(path: string, shrunk: readonly LengthChange[]): boolean {
  return shrunk.some(
    (change) => path === change.path || path.startsWith(`${change.path}.`),
  );
}

/** True when some ancestor of this path came back `null` where it was an object. */
function underNulled(path: string, retyped: readonly Retyped[]): boolean {
  return retyped.some(
    (change) => change.proxied === "null" && path.startsWith(`${change.path}.`),
  );
}

/**
 * The differences that matter, with the ones that do not already discounted.
 *
 * Two subtractions carry the argument. A path missing because the element
 * holding it was dropped is the SHRINK, counted once; and a path missing
 * because its parent came back `null` is the NULL, counted once. Reporting the
 * descendants too would turn one filtered object into fifty field-level
 * findings and bury the one that is real.
 */
export function diffShapes(direct: unknown, proxied: unknown): ShapeDiff {
  const from = shapeOf(direct);
  const to = shapeOf(proxied);
  const fromLengths = arrayLengths(direct);
  const toLengths = arrayLengths(proxied);

  const shrunk: LengthChange[] = [];
  const grew: LengthChange[] = [];
  for (const [path, length] of fromLengths) {
    const after = toLengths.get(path) ?? 0;
    if (after < length) shrunk.push({ path, direct: length, proxied: after });
    if (after > length) grew.push({ path, direct: length, proxied: after });
  }
  for (const [path, length] of toLengths) {
    if (!fromLengths.has(path)) grew.push({ path, direct: 0, proxied: length });
  }

  const retyped: Retyped[] = [];
  for (const [path, kinds] of to) {
    const before = from.get(path);
    if (before === undefined) continue;
    for (const kind of kinds) {
      if (!before.has(kind)) {
        retyped.push({ path, direct: [...before], proxied: kind });
      }
    }
  }

  const missing: ShapeEntry[] = [];
  for (const [path, kinds] of from) {
    if (to.has(path)) continue;
    if (underShrunkList(path, shrunk) || underNulled(path, retyped)) continue;
    missing.push({ path, kinds: [...kinds] });
  }

  const added: ShapeEntry[] = [];
  for (const [path, kinds] of to) {
    if (!from.has(path)) added.push({ path, kinds: [...kinds] });
  }

  const byPath = (a: { path: string }, b: { path: string }): number =>
    a.path.localeCompare(b.path);
  return {
    missing: missing.sort(byPath),
    added: added.sort(byPath),
    retyped: retyped.sort(byPath),
    shrunk: shrunk.sort(byPath),
    grew: grew.sort(byPath),
  };
}
