import {
  Kind,
  type ArgumentNode,
  type FieldNode,
  type ObjectFieldNode,
  type ObjectValueNode,
  type ValueNode,
} from "graphql";
import { isRecord } from "./narrow-ast";

/**
 * The NATIVE narrow: bounding the request when the vendor can do it, which is
 * cheaper than filtering the answer and lighter on the vendor (SPEC §4.4.2).
 *
 * The shape below is read off `@linear/sdk@90`'s own input types, not guessed:
 *   `IssueFilter.needs?: CustomerNeedCollectionFilter`
 *   `CustomerNeedCollectionFilter.some?: CustomerNeedFilter`   (also `every`, `length`)
 *   `CustomerNeedFilter.customer?: NullableCustomerFilter`
 *   `NullableCustomerFilter.id?: IdComparator`
 *   `IdComparator.eq?: ID`
 * `IssueFilter` has NO `customer` key at all — it has `customerCount` and
 * `customerImportantCount`, which is what M2 mistook for one. That filter was
 * rejected by the vendor, so M2's Linear narrowing never worked against the
 * real API.
 *
 * `some` and not `every`: an issue is in scope when AT LEAST ONE of its needs
 * names the mission's customer (SPEC §4.4.3, decided permissive).
 */

const FILTER = "filter";

function objectField(name: string, value: ValueNode): ObjectFieldNode {
  return { kind: Kind.OBJECT_FIELD, name: { kind: Kind.NAME, value: name }, value };
}

function wrap(key: string, inner: ObjectValueNode | ValueNode): ObjectValueNode {
  return { kind: Kind.OBJECT, fields: [objectField(key, inner)] };
}

/** `{ needs: { some: { customer: { id: { eq: "<id>" } } } } }` as AST. */
function missionFilterAst(customerId: string): ObjectValueNode {
  const eq = wrap("eq", { kind: Kind.STRING, value: customerId });
  return wrap("needs", wrap("some", wrap("customer", wrap("id", eq))));
}

/** The same filter as plain JSON, for the variables path. */
function missionFilterJson(customerId: string): Record<string, unknown> {
  return { needs: { some: { customer: { id: { eq: customerId } } } } };
}

/**
 * The agent keeps every filter it wrote, ANDed under ours.
 *
 * `IssueFilter.and` is a conjunction — "all of which need to be matched" — so
 * an agent filter can only ever NARROW the result set. Nothing has to be
 * stripped out of it, and nothing the agent wrote can widen past the mission:
 * an agent naming another customer's needs gets the intersection, which is the
 * issues that are already in scope.
 */
function mergeAst(agent: ObjectValueNode, customerId: string): ObjectValueNode {
  const ours = missionFilterAst(customerId);
  if (agent.fields.length === 0) return ours;
  const both: ValueNode = { kind: Kind.LIST, values: [agent, ours] };
  return { kind: Kind.OBJECT, fields: [objectField("and", both)] };
}

function mergeJson(
  agent: unknown,
  customerId: string,
): Record<string, unknown> | undefined {
  const ours = missionFilterJson(customerId);
  if (agent === undefined || agent === null) return ours;
  if (!isRecord(agent)) return undefined;
  if (Object.keys(agent).length === 0) return ours;
  return { and: [agent, ours] };
}

function withFilter(field: FieldNode, value: ObjectValueNode): FieldNode {
  const others = (field.arguments ?? []).filter((arg) => arg.name.value !== FILTER);
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
  const existing = (field.arguments ?? []).find((arg) => arg.name.value === FILTER);
  if (existing === undefined || existing.value.kind === Kind.NULL) {
    return { field: withFilter(field, missionFilterAst(customerId)) };
  }
  if (existing.value.kind === Kind.OBJECT) {
    return { field: withFilter(field, mergeAst(existing.value, customerId)) };
  }
  if (existing.value.kind === Kind.VARIABLE) {
    const name = existing.value.name.value;
    const sent =
      variables !== undefined && Object.hasOwn(variables, name)
        ? variables[name]
        : undefined;
    const merged = mergeJson(sent, customerId);
    if (merged === undefined) {
      return {
        reason: `\`filter\` variable \`$${name}\` is not an object — cannot be narrowed`,
      };
    }
    return { variables: { ...variables, [name]: merged } };
  }
  return { reason: "`filter` argument shape cannot be narrowed" };
}
