import type { FilterPlan, FilterRule } from "@missura/core";
import {
  Kind,
  OperationTypeNode,
  parse,
  print,
  type DocumentNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionNode,
} from "graphql";
import { inlineFragments } from "./narrow-fragments";
import { forwardRecord, readPayload } from "./narrow-payload";
import { narrowRoot } from "./narrow-roots";

export interface LinearNarrowResult {
  decision: "allow" | "deny";
  /** Present only when the document or its variables were rewritten. */
  body?: string;
  reason?: string;
  /**
   * What the proxy must do to the response: which objects to prove ours, and
   * which fields we added to make that possible and must take back.
   */
  filterPlan?: FilterPlan;
}

function deny(reason: string): LinearNarrowResult {
  return { decision: "deny", reason };
}

function rootFields(
  selections: readonly SelectionNode[],
): FieldNode[] | undefined {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) return undefined;
    fields.push(selection);
  }
  return fields;
}

interface RootState {
  fields: FieldNode[];
  rules: FilterRule[];
  strip: (readonly string[])[];
  fieldsChanged: boolean;
  variables: Record<string, unknown> | undefined;
  variablesChanged: boolean;
}

/**
 * Walks the root fields, applying the mission's scope policy. One denial ends
 * the whole document: partial narrowing would leave the denied field running
 * against the vendor with the mission's credential.
 */
function narrowRoots(
  roots: readonly FieldNode[],
  customerId: string | undefined,
  variables: Record<string, unknown> | undefined,
): RootState | string {
  const state: RootState = {
    fields: [],
    rules: [],
    strip: [],
    fieldsChanged: false,
    variables,
    variablesChanged: false,
  };
  for (const field of roots) {
    const outcome = narrowRoot(field, customerId, state.variables);
    if (outcome.reason !== undefined) return outcome.reason;
    state.fields.push(outcome.field ?? field);
    state.rules.push(...(outcome.rules ?? []));
    state.strip.push(...(outcome.strip ?? []));
    if (outcome.rewritten === true) state.fieldsChanged = true;
    if (outcome.variables !== undefined) {
      state.variables = outcome.variables;
      state.variablesChanged = true;
    }
  }
  return state;
}

function isOperation(
  definition: DocumentNode["definitions"][number],
): definition is OperationDefinitionNode {
  return definition.kind === Kind.OPERATION_DEFINITION;
}

/**
 * Prints the single operation and nothing else: fragments have been inlined,
 * so their definitions would now be dead weight the vendor still parses.
 */
function rebuild(
  operation: OperationDefinitionNode,
  fields: readonly FieldNode[],
): string {
  const rewritten: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        ...operation,
        selectionSet: { ...operation.selectionSet, selections: fields },
      },
    ],
  };
  return print(rewritten);
}

/**
 * Rewrites a Linear GraphQL request so the response can be filtered down to the
 * mission's customer, or refuses it.
 *
 * The refusals that remain are the ones filtering afterwards cannot repair
 * (SPEC §4.4.2): a write, a type the connector has not classified, a field that
 * would have to be removed although the vendor schema declares it non-nullable,
 * and every shape the rewrite cannot read at all — unreadable body, persisted
 * query, more than one operation. Everything else is allowed to run and comes
 * back through a `FilterPlan`.
 */
export function narrowLinear(
  body: string,
  scope: { linearCustomerId?: string },
): LinearNarrowResult {
  const payload = readPayload(body);
  if (typeof payload === "string") return deny(payload);

  let doc: DocumentNode;
  try {
    doc = parse(payload.query, { noLocation: true });
  } catch {
    // Fixed string: the parser echoes the source back, and this reason travels
    // to the agent.
    return deny("unparseable graphql");
  }
  const operations = doc.definitions.filter(isOperation);
  const operation = operations[0];
  if (operation === undefined || operations.length > 1) {
    return deny("exactly one operation is required");
  }
  if (operation.operation !== OperationTypeNode.QUERY) {
    return deny(`operation type \`${operation.operation}\` cannot be narrowed`);
  }
  const declared = rootFields(operation.selectionSet.selections);
  if (declared === undefined) {
    return deny("fragment at the document root — the scope policy needs named root fields");
  }
  const resolved = inlineFragments(doc, declared);
  if (resolved.reason !== undefined || resolved.fields === undefined) {
    return deny(resolved.reason ?? "document could not be resolved");
  }

  const state = narrowRoots(resolved.fields, scope.linearCustomerId, payload.variables);
  if (typeof state === "string") return deny(state);

  const plan: FilterPlan = { rules: state.rules, strip: state.strip };
  const rewrites =
    state.fieldsChanged ||
    state.variablesChanged ||
    resolved.inlined === true ||
    payload.carriesExtensions;
  if (!rewrites) return { decision: "allow", filterPlan: plan };
  const next = forwardRecord(
    payload,
    rebuild(operation, state.fields),
    state.variablesChanged ? state.variables : undefined,
  );
  return { decision: "allow", body: JSON.stringify(next), filterPlan: plan };
}
