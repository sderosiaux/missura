/**
 * JSON-shape helpers for the response FILTER: reading an owner out of a parsed
 * body, removing a field at a path, and keeping a count honest. No policy
 * lives here — these decide shape, never allow or deny.
 *
 * Everything rebuilds instead of mutating: the parsed body is shared with the
 * caller, and a half-applied plan on a mutated object is the one failure mode
 * that could serve a foreign object.
 */

/** A rebuilt value plus whether anything actually changed. */
export interface Rewritten {
  value: unknown;
  touched: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function omitKey(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([k]) => k !== key));
}

/**
 * The owning entity id of one object, or `undefined` when it cannot be proven:
 * a missing step, a `null`, a non-object on the way, or a leaf that is not a
 * non-empty string. Callers treat `undefined` as FOREIGN — there is no third
 * answer, because "we could not tell" and "it is not ours" must cost the same.
 */
export function ownerId(
  object: unknown,
  ownerPath: readonly string[],
): string | undefined {
  let current: unknown = object;
  for (const key of ownerPath) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return typeof current === "string" && current.length > 0
    ? current
    : undefined;
}

/**
 * Removes the field at `path` (body root first). A `"*"` segment means every
 * element of the array at that position, so one entry can reach into a list.
 * A path that does not resolve is a no-op: a plan may describe a field the
 * vendor did not return.
 */
export function stripAt(root: unknown, path: readonly string[]): Rewritten {
  const [head, ...rest] = path;
  if (head === undefined) return { value: root, touched: false };
  if (head === "*") {
    // A trailing `"*"` would name the elements themselves, not a field of
    // them: there is nothing to strip, so it stays a no-op.
    if (!Array.isArray(root) || rest.length === 0) {
      return { value: root, touched: false };
    }
    let touched = false;
    const out: unknown[] = [];
    for (const element of root) {
      const stripped = stripAt(element, rest);
      touched = touched || stripped.touched;
      out.push(stripped.value);
    }
    return touched ? { value: out, touched } : { value: root, touched: false };
  }
  if (!isRecord(root) || !Object.hasOwn(root, head)) {
    return { value: root, touched: false };
  }
  if (rest.length === 0) return { value: omitKey(root, head), touched: true };
  const child = stripAt(root[head], rest);
  return child.touched
    ? { value: { ...root, [head]: child.value }, touched: true }
    : { value: root, touched: false };
}

/**
 * Every spelling of "how many objects are there" we know how to meet next to a
 * list. Recomputing the wrong field would be worse than leaving it, so the set
 * is explicit rather than heuristic.
 */
const COUNT_FIELDS: readonly string[] = [
  "totalCount",
  "total_count",
  "count",
  "total",
];

/**
 * The count rule (SPEC/PRD §20.4): a number next to a list we filtered is
 * never passed through as the vendor sent it.
 *
 *   - it counted THIS page (value === objects before filtering) ⇒ recompute it
 *     from what remains;
 *   - it counts anything wider ⇒ REMOVE it. A global total is exactly the leak
 *     filtering exists to prevent: it reports the objects we just hid.
 *
 * Removing a field the vendor schema declares non-nullable would break the
 * SDK, which is why an unrecomputable aggregate is one of the four cases the
 * request-side walk must refuse BEFORE the call. This is the backstop for when
 * it did not.
 */
/**
 * The count rule again, after a REFILL merged several pages into one: a number
 * that survived `recount` on each page described that page, so next to the
 * merged list it must describe the merged list. Anything wider was already
 * removed page by page and cannot reappear here.
 */
export function recountTo(
  container: Record<string, unknown>,
  total: number,
): Record<string, unknown> {
  let out = container;
  for (const field of COUNT_FIELDS) {
    if (!Object.hasOwn(out, field)) continue;
    if (typeof out[field] !== "number") continue;
    out = { ...out, [field]: total };
  }
  return out;
}

export function recount(
  container: Record<string, unknown>,
  before: number,
  after: number,
): Rewritten {
  let out = container;
  let touched = false;
  for (const field of COUNT_FIELDS) {
    if (!Object.hasOwn(out, field)) continue;
    const value = out[field];
    if (typeof value !== "number") continue;
    if (value === before) {
      if (before === after) continue;
      out = { ...out, [field]: after };
    } else {
      out = omitKey(out, field);
    }
    touched = true;
  }
  return { value: out, touched };
}
