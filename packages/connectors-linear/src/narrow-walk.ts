import type { FilterRule } from "@missura/core";
import { Kind, type FieldNode, type SelectionNode } from "graphql";
import { responseKey } from "./narrow-ast";
import { withOwnerSelection } from "./narrow-owner";
import {
  METADATA_CUSTOMER_COLLECTIONS,
  METADATA_NON_NULLABLE_CUSTOMER_SINGLES,
  ownerPath,
  typeClass,
} from "./schema/classification";
import { fieldInfo, leafType, unionMembers, type FieldInfo } from "./schema/schema";

/**
 * The type-driven walk that replaced M2's hand-written path allowlist.
 *
 * Every field is resolved through the pinned artifact, and its RETURN TYPE
 * decides what happens — not its name and not the path it sits on:
 *   - unknown field or unknown type ⇒ DENY. Deny by default applies to the
 *     type, so a relation nobody classified cannot be reached from anywhere;
 *   - `metadata` ⇒ allow and keep walking, EXCEPT the two shapes a response
 *     filter could not repair (below);
 *   - `customer-scoped` ⇒ allow, make ownership provable, and emit a rule so
 *     the proxy can drop or null what is not ours;
 *   - a scalar leaf ⇒ always fine.
 *
 * `team { issues { … } }` is still refused — by type now: a COLLECTION of a
 * customer-scoped type under a metadata type cannot be repaired by nulling and
 * re-expands to the whole workspace. So is a NON-NULLABLE single one
 * (`IssueRelation.issue`): removing it would hand the SDK a body its own types
 * reject, so it must be refused before the call (SPEC §4.4.2, case 3).
 */

export interface WalkRequest {
  selections: readonly SelectionNode[];
  /** The vendor type the selections are written against. */
  type: string;
  /** Response path of the object those selections describe, body root first. */
  path: readonly string[];
  customerId: string;
  /**
   * May the object at `path` itself be replaced by `null` when it turns out to
   * be foreign? Read only when `type` is customer-scoped — a root field like
   * `issue(id:)` is guarded by nothing above it, so the guard has to be applied
   * here rather than by the field that selected it.
   */
  nullable?: boolean;
}

interface Collector {
  customerId: string;
  rules: FilterRule[];
  strip: (readonly string[])[];
  rewritten: boolean;
}

const TYPENAME = "__typename";

function guarded(
  table: Readonly<Record<string, readonly string[]>>,
  parentType: string,
  field: string,
): boolean {
  return Object.hasOwn(table, parentType) && table[parentType]?.includes(field) === true;
}

/** Response path of a field's value: a list gets a `"*"` for its elements. */
function childPath(
  path: readonly string[],
  field: FieldNode,
  info: FieldInfo,
): readonly string[] {
  const key = responseKey(field);
  return info.list ? [...path, key, "*"] : [...path, key];
}

/**
 * Guards one customer-scoped object (or every element of a list of them): make
 * its owner selectable, and emit the rule that proves it on the way back.
 */
function guard(
  selections: readonly SelectionNode[],
  type: string,
  here: readonly string[],
  nullable: boolean,
  collector: Collector,
): readonly SelectionNode[] | string {
  const owner = ownerPath(type);
  if (owner === undefined) {
    return `\`${type}\` is customer-scoped but the connector cannot reach its owning customer`;
  }
  const proven = withOwnerSelection(selections, owner);
  if (typeof proven === "string") return `\`${type}\`: ${proven}`;
  const injectedAt = proven.injectedAt;
  const injected: string[] = injectedAt?.length === 1 ? [...injectedAt] : [];
  if (injectedAt !== undefined) {
    // Longer than one segment means we widened INSIDE a field the agent asked
    // for: `injected` cannot name that, so it leaves by absolute path.
    if (injected.length === 0) collector.strip.push([...here, ...injectedAt]);
    collector.rewritten = true;
  }
  collector.rules.push({
    path: here,
    type,
    ownerPath: owner,
    expectedOwnerIds: [collector.customerId],
    ownerMatch: "exact",
    injected,
    // A foreign single object is nulled only where the vendor schema allows it;
    // anywhere else the response fails closed, which is why the walk lets it
    // through at all.
    nullable,
  });
  return proven.selections;
}

function walkField(
  field: FieldNode,
  parentType: string,
  path: readonly string[],
  collector: Collector,
): SelectionNode | string {
  const name = field.name.value;
  if (name === TYPENAME) {
    return field.selectionSet === undefined
      ? field
      : "`__typename` is a scalar and carries no selection";
  }
  const info = fieldInfo(parentType, name);
  if (info === undefined) {
    return `field \`${name}\` is not a field of \`${parentType}\` the connector models`;
  }
  if (guarded(METADATA_CUSTOMER_COLLECTIONS, parentType, name)) {
    return `\`${parentType}.${name}\` is a collection of customer-scoped \`${info.type}\` under workspace metadata — it re-expands past the mission`;
  }
  if (guarded(METADATA_NON_NULLABLE_CUSTOMER_SINGLES, parentType, name)) {
    return `\`${parentType}.${name}\` is a non-nullable \`${info.type}\` — a foreign one could not be removed without breaking the vendor schema`;
  }
  const klass = typeClass(info.type);
  if (klass === "denied") {
    return `\`${parentType}.${name}\` returns \`${info.type}\`, a type the connector has not classified`;
  }
  const inner = field.selectionSet?.selections;
  if (leafType(info.type)) {
    return inner === undefined
      ? field
      : `\`${parentType}.${name}\` is the scalar \`${info.type}\` and carries no selection`;
  }
  if (inner === undefined) {
    return `\`${parentType}.${name}\` returns \`${info.type}\` and must select fields`;
  }
  const walked = walkSelections(
    { selections: inner, type: info.type, path: childPath(path, field, info) },
    collector,
  );
  if (typeof walked === "string") return walked;
  const proven =
    klass === "customer-scoped"
      ? guard(walked, info.type, childPath(path, field, info), info.nullable, collector)
      : walked;
  if (typeof proven === "string") return proven;
  if (proven === inner) return field;
  collector.rewritten = true;
  return {
    ...field,
    selectionSet: { kind: Kind.SELECTION_SET, selections: proven },
  };
}

/**
 * A union has no fields of its own. GraphQL's own rule — enter it only through
 * `... on <Member>` — is also the safe one here, so it is the rule enforced:
 * a bare field under a union would have to be resolved by guessing a member.
 */
function walkUnion(
  selection: SelectionNode,
  members: readonly string[],
  request: Omit<WalkRequest, "customerId">,
  collector: Collector,
): SelectionNode | string {
  if (selection.kind === Kind.FIELD) {
    return selection.name.value === TYPENAME && selection.selectionSet === undefined
      ? selection
      : `\`${request.type}\` is a union — select \`... on <member>\`, not \`${selection.name.value}\``;
  }
  if (selection.kind !== Kind.INLINE_FRAGMENT) {
    return `unresolved fragment under \`${request.type}\``;
  }
  const condition = selection.typeCondition?.name.value;
  if (condition === undefined || !members.includes(condition)) {
    return `\`... on ${condition ?? "?"}\` is not a member of the union \`${request.type}\``;
  }
  const walked = walkSelections(
    { ...request, selections: selection.selectionSet.selections, type: condition },
    collector,
  );
  if (typeof walked === "string") return walked;
  return walked === selection.selectionSet.selections
    ? selection
    : { ...selection, selectionSet: { ...selection.selectionSet, selections: walked } };
}

function walkSelections(
  request: Omit<WalkRequest, "customerId">,
  collector: Collector,
): readonly SelectionNode[] | string {
  const members = unionMembers(request.type);
  const out: SelectionNode[] = [];
  let changed = false;
  for (const selection of request.selections) {
    const walked =
      members !== undefined
        ? walkUnion(selection, members, request, collector)
        : walkOne(selection, request, collector);
    if (typeof walked === "string") return walked;
    if (walked !== selection) changed = true;
    out.push(walked);
  }
  return changed ? out : request.selections;
}

/**
 * An inline fragment that survived resolution carries a type condition, and a
 * condition can only narrow to the type we are already on (a union member is
 * handled by `walkUnion`). Anything else would let a document be written
 * against a type the walk is not checking.
 */
function walkOne(
  selection: SelectionNode,
  request: Omit<WalkRequest, "customerId">,
  collector: Collector,
): SelectionNode | string {
  if (selection.kind === Kind.FIELD) {
    return walkField(selection, request.type, request.path, collector);
  }
  if (selection.kind !== Kind.INLINE_FRAGMENT) {
    // Fragments are resolved before the walk; one reaching here would be an
    // unproven path, so it dies with the document.
    return `unresolved fragment under \`${request.type}\``;
  }
  const condition = selection.typeCondition?.name.value;
  if (condition !== undefined && condition !== request.type) {
    return `\`... on ${condition}\` under \`${request.type}\` narrows to another type — refused`;
  }
  const walked = walkSelections(
    { ...request, selections: selection.selectionSet.selections },
    collector,
  );
  if (typeof walked === "string") return walked;
  return walked === selection.selectionSet.selections
    ? selection
    : { ...selection, selectionSet: { ...selection.selectionSet, selections: walked } };
}

export interface WalkResult {
  reason?: string;
  selections?: readonly SelectionNode[];
  rules?: readonly FilterRule[];
  strip?: readonly (readonly string[])[];
  rewritten?: boolean;
}

/**
 * Walks one root field's selection set. The whole document dies on the first
 * denial: partial narrowing would leave the denied field running against the
 * vendor with the mission's credential.
 */
export function walkSelectionSet(request: WalkRequest): WalkResult {
  const collector: Collector = {
    customerId: request.customerId,
    rules: [],
    strip: [],
    rewritten: false,
  };
  const walked = walkSelections(request, collector);
  if (typeof walked === "string") return { reason: walked };
  const proven =
    typeClass(request.type) === "customer-scoped"
      ? guard(walked, request.type, request.path, request.nullable === true, collector)
      : walked;
  if (typeof proven === "string") return { reason: proven };
  return {
    selections: proven,
    rules: collector.rules,
    strip: collector.strip,
    rewritten: collector.rewritten,
  };
}
