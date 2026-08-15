import {
  Kind,
  type ArgumentNode,
  type FieldNode,
  type ObjectFieldNode,
  type ObjectValueNode,
  type ValueNode,
} from "graphql";

/** The relation every narrowing decision hangs on. */
export const CUSTOMER = "customer";
const FILTER = "filter";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectField(name: string, value: ValueNode): ObjectFieldNode {
  return {
    kind: Kind.OBJECT_FIELD,
    name: { kind: Kind.NAME, value: name },
    value,
  };
}

/** `{ customer: { id: { eq: "<id>" } } }` as AST. */
function customerFilterAst(customerId: string): ObjectValueNode {
  const eq: ObjectValueNode = {
    kind: Kind.OBJECT,
    fields: [objectField("eq", { kind: Kind.STRING, value: customerId })],
  };
  const id: ObjectValueNode = { kind: Kind.OBJECT, fields: [objectField("id", eq)] };
  return { kind: Kind.OBJECT, fields: [objectField(CUSTOMER, id)] };
}

/** The same filter as plain JSON, for the variables path. */
function customerFilterJson(customerId: string): Record<string, unknown> {
  return { [CUSTOMER]: { id: { eq: customerId } } };
}

/**
 * The agent keeps every filter it asked for except its own `customer` one:
 * ours replaces it, and the rest is ANDed under it. Narrower stays narrower,
 * broader cannot widen past the mission.
 */
function mergeAst(agent: ObjectValueNode, customerId: string): ObjectValueNode {
  const rest = agent.fields.filter((field) => field.name.value !== CUSTOMER);
  const ours = customerFilterAst(customerId);
  if (rest.length === 0) return ours;
  const both: ValueNode = {
    kind: Kind.LIST,
    values: [{ kind: Kind.OBJECT, fields: rest }, ours],
  };
  return { kind: Kind.OBJECT, fields: [objectField("and", both)] };
}

function mergeJson(
  agent: unknown,
  customerId: string,
): Record<string, unknown> | undefined {
  const ours = customerFilterJson(customerId);
  if (agent === undefined || agent === null) return ours;
  if (!isRecord(agent)) return undefined;
  const rest = Object.fromEntries(
    Object.entries(agent).filter(([key]) => key !== CUSTOMER),
  );
  if (Object.keys(rest).length === 0) return ours;
  return { and: [rest, ours] };
}

function withFilter(field: FieldNode, value: ObjectValueNode): FieldNode {
  const others = (field.arguments ?? []).filter(
    (arg) => arg.name.value !== FILTER,
  );
  const injected: ArgumentNode = {
    kind: Kind.ARGUMENT,
    name: { kind: Kind.NAME, value: FILTER },
    value,
  };
  return { ...field, arguments: [...others, injected] };
}

export interface FilterOutcome {
  /** Set when the request cannot be narrowed — the whole document dies. */
  reason?: string;
  field?: FieldNode;
  variables?: Record<string, unknown>;
}

/**
 * Injects the mission's customer filter into an `issues` field, inline or
 * through the variable the agent routed its filter by. Any filter shape the
 * merge cannot reason about is a refusal, never a pass-through.
 */
export function narrowIssuesField(
  field: FieldNode,
  customerId: string,
  variables: Record<string, unknown> | undefined,
): FilterOutcome {
  const existing = (field.arguments ?? []).find(
    (arg) => arg.name.value === FILTER,
  );
  if (existing === undefined || existing.value.kind === Kind.NULL) {
    return { field: withFilter(field, customerFilterAst(customerId)) };
  }
  if (existing.value.kind === Kind.OBJECT) {
    return { field: withFilter(field, mergeAst(existing.value, customerId)) };
  }
  if (existing.value.kind === Kind.VARIABLE) {
    const name = existing.value.name.value;
    const merged = mergeJson(variables?.[name], customerId);
    if (merged === undefined) {
      return {
        reason: `\`filter\` variable \`$${name}\` is not an object — cannot be narrowed`,
      };
    }
    return { variables: { ...variables, [name]: merged } };
  }
  return { reason: "`filter` argument shape cannot be narrowed" };
}
