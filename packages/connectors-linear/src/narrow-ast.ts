import { Kind, type FieldNode, type SelectionNode, type ValueNode } from "graphql";

/**
 * The small AST vocabulary the narrowing shares: how a selection will be keyed
 * in the response, how to build a field we inject, and how to read an argument
 * the agent may have routed through a variable.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the vendor's JSON response will key this selection by. */
export function responseKey(selection: FieldNode): string {
  return selection.alias?.value ?? selection.name.value;
}

export function fieldNode(name: string, inner?: readonly SelectionNode[]): FieldNode {
  const base: FieldNode = { kind: Kind.FIELD, name: { kind: Kind.NAME, value: name } };
  return inner === undefined
    ? base
    : { ...base, selectionSet: { kind: Kind.SELECTION_SET, selections: inner } };
}

/**
 * The field selection whose response key is `key`, or `undefined`. Own search
 * over the array, so no prototype key can answer for a selection nobody wrote.
 */
export function selectionFor(
  selections: readonly SelectionNode[],
  key: string,
): FieldNode | undefined {
  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) continue;
    if (responseKey(selection) === key) return selection;
  }
  return undefined;
}

const ID = "id";

/**
 * The `id` argument of a root field, whether written inline or passed by
 * variable. Anything that does not resolve to a string is `undefined` — the
 * caller treats an unresolvable id as out of scope.
 */
export function resolveIdArgument(
  field: FieldNode,
  variables: Record<string, unknown> | undefined,
): string | undefined {
  const arg = (field.arguments ?? []).find((a) => a.name.value === ID);
  if (arg === undefined) return undefined;
  const value: ValueNode = arg.value;
  if (value.kind === Kind.STRING) return value.value;
  if (value.kind !== Kind.VARIABLE) return undefined;
  if (!isRecord(variables)) return undefined;
  const resolved = variables[value.name.value];
  return typeof resolved === "string" ? resolved : undefined;
}
