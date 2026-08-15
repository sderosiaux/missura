import { Kind, type FieldNode, type SelectionNode } from "graphql";
import { CUSTOMER, isRecord } from "./narrow-filter";

const ID = "id";

/** What the vendor's JSON response will key this selection by. */
export function responseKey(selection: FieldNode): string {
  return selection.alias?.value ?? selection.name.value;
}

function fieldNode(name: string): FieldNode {
  return { kind: Kind.FIELD, name: { kind: Kind.NAME, value: name } };
}

function customerIdSelection(): FieldNode {
  return {
    ...fieldNode(CUSTOMER),
    selectionSet: { kind: Kind.SELECTION_SET, selections: [fieldNode(ID)] },
  };
}

function fieldsOf(selections: readonly SelectionNode[]): FieldNode[] | undefined {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) return undefined;
    fields.push(selection);
  }
  return fields;
}

export interface IssueOutcome {
  reason?: string;
  field?: FieldNode;
  /** True only when the whole `customer` key is ours to strip back out. */
  injectedSelection?: boolean;
}

/**
 * Makes the ownership post-check possible: the response must carry
 * `customer.id`. The relation is added when absent — and only then is it ours
 * to remove from the response afterwards. A selection whose `customer` key is
 * an alias for another field is refused: the check would read a value the
 * agent chose.
 */
export function narrowIssueField(field: FieldNode): IssueOutcome {
  const selections = field.selectionSet?.selections;
  if (selections === undefined) {
    return { reason: "`issue` selection is empty — nothing to verify" };
  }
  const fields = fieldsOf(selections);
  if (fields === undefined) {
    return {
      reason: "fragment inside the `issue` selection — ownership cannot be proven",
    };
  }
  const existing = fields.find((sel) => responseKey(sel) === CUSTOMER);
  if (existing === undefined) {
    return {
      field: {
        ...field,
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [...fields, customerIdSelection()],
        },
      },
      injectedSelection: true,
    };
  }
  if (existing.name.value !== CUSTOMER) {
    return {
      reason: "response key `customer` is aliased to another field — refused",
    };
  }
  return withCustomerId(field, fields, existing);
}

/** Ensures `id` sits inside the customer selection the agent already asked for. */
function withCustomerId(
  field: FieldNode,
  fields: readonly FieldNode[],
  customer: FieldNode,
): IssueOutcome {
  const inner = customer.selectionSet?.selections;
  if (inner === undefined) {
    return { reason: "`customer` selection is empty — ownership cannot be proven" };
  }
  const innerFields = fieldsOf(inner);
  if (innerFields === undefined) {
    return {
      reason: "fragment inside the `customer` selection — ownership cannot be proven",
    };
  }
  const idField = innerFields.find((sel) => responseKey(sel) === ID);
  if (idField !== undefined) {
    if (idField.name.value !== ID) {
      return { reason: "response key `id` is aliased to another field — refused" };
    }
    return { field, injectedSelection: false };
  }
  const widened: FieldNode = {
    ...customer,
    selectionSet: {
      kind: Kind.SELECTION_SET,
      selections: [...innerFields, fieldNode(ID)],
    },
  };
  return {
    field: {
      ...field,
      selectionSet: {
        kind: Kind.SELECTION_SET,
        selections: fields.map((sel) => (sel === customer ? widened : sel)),
      },
    },
    injectedSelection: false,
  };
}

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
  if (arg.value.kind === Kind.STRING) return arg.value.value;
  if (arg.value.kind !== Kind.VARIABLE) return undefined;
  if (!isRecord(variables)) return undefined;
  const value = variables[arg.value.name.value];
  return typeof value === "string" ? value : undefined;
}
