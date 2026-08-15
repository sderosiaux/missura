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
 * list. Acting on the wrong field would be worse than leaving it, so the set is
 * explicit rather than heuristic.
 */
const COUNT_FIELDS: readonly string[] = [
  "totalCount",
  "total_count",
  "count",
  "total",
];

/**
 * Every spelling of "this result set is complete" we know how to meet next to
 * a list. Same explicitness as the counts, and a much shorter list: only
 * GitHub's search endpoints publish one.
 */
const COMPLETENESS_FIELDS: readonly string[] = ["incomplete_results"];

/**
 * The count rule (SPEC/PRD §20.4): a number next to a list a plan applies to
 * is REMOVED, always.
 *
 * The earlier rule recomputed a count that happened to equal the page and
 * removed anything wider. That made the field's PRESENCE a function of the
 * vendor's hidden total — `present ⟺ globalTotal ≤ pageSize` — so an agent
 * could binary-search the page size, watch the field appear, and read off the
 * exact number of matches across everything the vendor credential can reach,
 * without ever receiving one authorized object. Presence must depend on the
 * PLAN and nothing else, and "gone whenever we filtered" is the only version of
 * that which needs no per-field knowledge of what the vendor was counting.
 *
 * Removing a field the vendor schema declares non-nullable would break the SDK,
 * which is why an unrecomputable aggregate is one of the four cases the
 * request-side walk must refuse BEFORE the call. This is the backstop for when
 * it did not.
 *
 * The completeness flag moves the other way: a page we removed from is not
 * complete, and neither is one a plan merely applied to — flipping it only when
 * something WAS removed would answer "did this page hold objects I may not
 * see?" one page at a time, which is the same oracle wearing a boolean. It is
 * set to `true` whenever the plan reaches the list, and never invented on a
 * vendor that does not send it.
 */
export function honestList(container: Record<string, unknown>): Rewritten {
  let out = container;
  let touched = false;
  for (const field of COUNT_FIELDS) {
    if (!Object.hasOwn(out, field)) continue;
    out = omitKey(out, field);
    touched = true;
  }
  for (const field of COMPLETENESS_FIELDS) {
    if (!Object.hasOwn(out, field)) continue;
    if (out[field] === true) continue;
    out = { ...out, [field]: true };
    touched = true;
  }
  return { value: out, touched };
}
