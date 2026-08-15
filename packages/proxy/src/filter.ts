import type { FilterPlan, FilterRule } from "@missura/core";
import { honestList, isRecord, stripAt } from "./filter-json";
import { isOwned } from "./filter-owner";
import {
  NOT_FOUND_GRAPHQL_BODY,
  notFoundAnswer,
  OUT_OF_SCOPE_REASON,
  type NarrowPostCheck,
  type NarrowResult,
} from "./narrow";

/**
 * The response FILTER: the enforcement point moved from "refuse the request"
 * to "let it run and filter the answer" (SPEC §4.4.2). A connector says where
 * the owned objects land and how to prove ownership (`FilterPlan`); this file
 * applies that to the parsed body and knows nothing about the vendor.
 *
 * One mechanism, not two: the M2 `applyPostCheck` is gone — its post-check is
 * translated into a one-rule plan by `planFromPostCheck` and runs through the
 * same walk, so there is a single place where an object is proven ours.
 */

/** The response could not be repaired, so none of it is served. */
export const UNFILTERABLE_REASON = "unfilterable";

export interface FilterOutcome {
  /** `false` ⇒ fail closed: `body` is the vendor-shaped not-found. */
  ok: boolean;
  body: string;
  /** Dropped from a list or nulled — what the audit record reports. */
  objectsRemoved: number;
}

/** What the pipeline carries from NARROW to the filter, once. */
export interface FilterTask {
  plan: FilterPlan;
  /** Audit reason when the filter fails closed. */
  denyReason: string;
  /**
   * The body a fail-closed filter answers with, in the vendor's own envelope so
   * an SDK can parse it. Under `github404` it is GitHub's bare not-found; under
   * GraphQL it is a constant that does NOT match Linear's own absence bytes —
   * see `NOT_FOUND_GRAPHQL_BODY` and SPEC §7 for what an attacker learns from
   * the difference.
   */
  notFoundBody: string;
  /**
   * The status that body is served at: the connector's own absence status, and
   * never the upstream one. It travels WITH the body because the pair is what
   * makes a refusal indistinguishable from an absence — a vendor-shaped
   * not-found returned at the vendor's 200 would announce, by its status line
   * alone, that the object exists (`notFoundAnswer` in `narrow.ts`).
   */
  notFoundStatus: number;
}

interface RuleOutcome {
  value: unknown;
  removed: number;
  touched: boolean;
  ok: boolean;
}

function kept(value: unknown): RuleOutcome {
  return { value, removed: 0, touched: false, ok: true };
}

const FAILED: RuleOutcome = {
  value: undefined,
  removed: 0,
  touched: false,
  ok: false,
};

/**
 * A foreign single object: `null` when the vendor schema allows it, otherwise
 * fail closed. Returning it is never an option, and neither is removing a
 * non-nullable field the SDK's own types require.
 */
function single(node: unknown, rule: FilterRule): RuleOutcome {
  // The vendor returned no object at all: nothing to own, nothing to leak.
  if (node === null || node === undefined) return kept(node);
  if (isOwned(node, rule)) return kept(node);
  if (!rule.nullable) return FAILED;
  return { value: null, removed: 1, touched: true, ok: true };
}

/** Drops every element that is not provably ours. */
function dropForeign(
  elements: readonly unknown[],
  rule: FilterRule,
): { kept: unknown[]; removed: number } {
  const survivors = elements.filter((element) => isOwned(element, rule));
  return { kept: survivors, removed: elements.length - survivors.length };
}

/**
 * A list rule reached through its container, which is what makes the count
 * rule possible: the number that describes the list, and the flag that claims
 * it is complete, both sit next to it.
 *
 * `honestList` runs on the container whatever the elements turned out to be —
 * it is the plan reaching this list that removes the count, not the plan
 * finding something to drop. Anything conditional there is readable as "this
 * page held objects you may not see".
 */
function filterList(
  container: Record<string, unknown>,
  key: string,
  rule: FilterRule,
): RuleOutcome {
  const list = container[key];
  if (list === null || list === undefined) return kept(container);
  if (!Array.isArray(list)) return FAILED;
  const { kept: survivors, removed } = dropForeign(list, rule);
  const counted = honestList(container);
  if (removed === 0 && !counted.touched) return kept(container);
  const rebuilt = isRecord(counted.value) ? counted.value : container;
  return {
    value: { ...rebuilt, [key]: survivors },
    removed,
    touched: true,
    ok: true,
  };
}

/** A `"*"` segment: every element of the array, filtered or walked through. */
function eachElement(
  node: unknown,
  rest: readonly string[],
  rule: FilterRule,
): RuleOutcome {
  if (node === null || node === undefined) return kept(node);
  if (!Array.isArray(node)) return FAILED;
  // A list at the body root (REST collections): no container, so no count to
  // recompute — the drop is all there is to do.
  if (rest.length === 0) {
    const { kept: survivors, removed } = dropForeign(node, rule);
    return removed === 0
      ? kept(node)
      : { value: survivors, removed, touched: true, ok: true };
  }
  let removed = 0;
  let touched = false;
  const out: unknown[] = [];
  for (const element of node) {
    const walked = walk(element, rest, rule);
    if (!walked.ok) return FAILED;
    removed += walked.removed;
    touched = touched || walked.touched;
    out.push(walked.value);
  }
  return touched
    ? { value: out, removed, touched, ok: true }
    : { value: node, removed, touched: false, ok: true };
}

/**
 * Resolves one rule's path against the body. A path that does not resolve
 * describes objects the vendor did not return — nothing to filter, and the
 * body stays as it is.
 */
function walk(
  node: unknown,
  segments: readonly string[],
  rule: FilterRule,
): RuleOutcome {
  const [head, ...rest] = segments;
  if (head === undefined) return single(node, rule);
  if (head === "*") return eachElement(node, rest, rule);
  if (!isRecord(node) || !Object.hasOwn(node, head)) return kept(node);
  if (rest.length === 1 && rest[0] === "*") return filterList(node, head, rule);
  const child = walk(node[head], rest, rule);
  if (!child.ok) return FAILED;
  return child.touched
    ? { ...child, value: { ...node, [head]: child.value } }
    : { ...child, value: node };
}

/**
 * Everything to remove on the way out: what we injected to make the ownership
 * check possible, plus what the connector strips outright. An `injected` entry
 * is a field of the object the rule guards, so it becomes that rule's path
 * plus one segment — including under a `"*"`, where it reaches every element.
 */
function stripPaths(plan: FilterPlan): readonly (readonly string[])[] {
  return [
    ...plan.strip,
    ...plan.rules.flatMap((rule) =>
      rule.injected.map((field) => [...rule.path, field]),
    ),
  ];
}

/**
 * Applies a plan to a vendor response.
 *
 * Order matters: ownership is decided first, because the discriminator we are
 * about to strip is what proves it. Anything unparseable, and any foreign
 * object the plan cannot remove, fails closed — an unverifiable object is
 * treated exactly like a foreign one.
 */
export function applyFilterPlan(
  plan: FilterPlan,
  body: string,
  notFoundBody: string = NOT_FOUND_GRAPHQL_BODY,
): FilterOutcome {
  const failure: FilterOutcome = {
    ok: false,
    body: notFoundBody,
    objectsRemoved: 0,
  };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return failure;
  }
  let removed = 0;
  let touched = false;
  for (const rule of plan.rules) {
    const applied = walk(value, rule.path, rule);
    if (!applied.ok) return failure;
    value = applied.value;
    removed += applied.removed;
    touched = touched || applied.touched;
  }
  for (const path of stripPaths(plan)) {
    const stripped = stripAt(value, path);
    value = stripped.value;
    touched = touched || stripped.touched;
  }
  // Untouched means untouched: the agent gets the vendor's bytes, not a
  // re-serialization of them.
  return {
    ok: true,
    body: touched ? JSON.stringify(value) : body,
    objectsRemoved: removed,
  };
}

/**
 * The M2 post-check as a plan. `path` is `<object>.<relation>.<field>`, so the
 * object it guards is the path minus its last two segments and the owner is
 * those two. It is never nullable: M2 answered a foreign object with the
 * vendor's not-found, and nulling a field M2 never proved nullable would break
 * the SDK.
 */
export function planFromPostCheck(check: NarrowPostCheck): FilterPlan {
  const path = check.path.slice(0, -2);
  const relation = check.path[check.path.length - 2] ?? "";
  const rule: FilterRule = {
    path,
    // M2's post-check predates type-driven narrowing: it proved ownership
    // without ever naming the type it was proving it for.
    type: "unknown",
    ownerPath: check.path.slice(-2),
    // One owner, and an opaque vendor id: the M2 post-check resolved a single
    // customer and Linear's ids are exact strings, never spelled two ways.
    expectedOwnerIds: [check.expectedCustomerId],
    ownerMatch: "exact",
    injected: check.injectedSelection === "relation" ? [relation] : [],
    nullable: false,
  };
  return {
    rules: [rule],
    // We widened a relation the agent asked for: the leaf is ours, the
    // relation is the agent's.
    strip: check.injectedSelection === "id" ? [[...check.path]] : [],
  };
}

/**
 * The one filter a request gets, from whichever mechanism NARROW used.
 *
 * The two deny reasons are not two mechanisms: `unfilterable` is what a plan
 * reports, and `out-of-scope object` is kept for the M2 post-check so the
 * decision log does not change meaning under a connector using the shortcut.
 * No shipped connector does any more, so this branch is reachable only from its
 * own unit test — it goes when `NarrowPostCheck` goes.
 */
export function filterTask(narrowed: NarrowResult): FilterTask | undefined {
  const absence = notFoundAnswer(narrowed.denyShape);
  const answer = {
    notFoundBody: absence.body,
    notFoundStatus: absence.status,
  };
  if (narrowed.filterPlan !== undefined) {
    return {
      plan: narrowed.filterPlan,
      denyReason: UNFILTERABLE_REASON,
      ...answer,
    };
  }
  if (narrowed.postCheck !== undefined) {
    return {
      plan: planFromPostCheck(narrowed.postCheck),
      denyReason: OUT_OF_SCOPE_REASON,
      ...answer,
    };
  }
  return undefined;
}
