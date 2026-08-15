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
import { narrowIssuesField } from "./narrow-filter";
import { inlineFragments } from "./narrow-fragments";
import {
  narrowIssueField,
  resolveIdArgument,
  responseKey,
  type InjectedSelection,
} from "./narrow-issue";
import { forwardRecord, readPayload } from "./narrow-payload";
import { traversalDenial } from "./narrow-walk";

/**
 * Response-side ownership check handed to the proxy. Structurally identical to
 * the proxy's `NarrowPostCheck` — declared here because a connector never
 * imports the proxy.
 */
export interface LinearNarrowPostCheck {
  path: string[];
  expectedCustomerId: string;
  injectedSelection: InjectedSelection;
}

export interface LinearNarrowResult {
  decision: "allow" | "deny";
  /** Present only when the document or its variables were rewritten. */
  body?: string;
  reason?: string;
  postCheck?: LinearNarrowPostCheck;
}

const NO_RELATION = "no proven relation to mission customer";
const OUT_OF_SCOPE_CUSTOMER = "out-of-scope customer";
const NOT_IN_SCOPE = "linear not in mission scope";
const UNRELATED_ROOT_FIELDS: ReadonlySet<string> = new Set([
  "projects",
  "project",
  "comments",
  "comment",
]);

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
  fieldsChanged: boolean;
  variables: Record<string, unknown> | undefined;
  variablesChanged: boolean;
  postCheck?: LinearNarrowPostCheck;
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
    fieldsChanged: false,
    variables,
    variablesChanged: false,
  };
  for (const field of roots) {
    const name = field.name.value;
    if (customerId === undefined) {
      if (name !== "viewer") return NOT_IN_SCOPE;
      state.fields.push(field);
      continue;
    }
    if (name === "viewer") {
      state.fields.push(field);
      continue;
    }
    if (name === "issues") {
      const outcome = narrowIssuesField(field, customerId, state.variables);
      if (outcome.reason !== undefined) return outcome.reason;
      if (outcome.variables !== undefined) {
        state.variables = outcome.variables;
        state.variablesChanged = true;
        state.fields.push(field);
      } else {
        state.fields.push(outcome.field ?? field);
        state.fieldsChanged = true;
      }
      continue;
    }
    if (name === "issue") {
      if (state.postCheck !== undefined) {
        return "a document may carry only one `issue` root field — one ownership check each";
      }
      const outcome = narrowIssueField(field);
      if (outcome.reason !== undefined) return outcome.reason;
      const next = outcome.field ?? field;
      if (next !== field) state.fieldsChanged = true;
      state.fields.push(next);
      state.postCheck = {
        path: ["data", responseKey(field), "customer", "id"],
        expectedCustomerId: customerId,
        injectedSelection: outcome.injectedSelection ?? "none",
      };
      continue;
    }
    if (name === "customer") {
      if (resolveIdArgument(field, state.variables) !== customerId) {
        return OUT_OF_SCOPE_CUSTOMER;
      }
      state.fields.push(field);
      continue;
    }
    if (name === "customers") {
      return "`customers` cannot be narrowed to the mission — use customer(id)";
    }
    if (UNRELATED_ROOT_FIELDS.has(name)) return NO_RELATION;
    return `root field \`${name}\` is not narrowable under a mission scope`;
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
 * Rewrites a Linear GraphQL request so it can only see the mission's customer,
 * or refuses it. Deny by default: every shape the rewrite cannot reason about
 * — unreadable body, fragment where a relation must be proven, filter it
 * cannot merge — is a refusal, never an untouched pass-through.
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
  // Walked on the fields that will actually be forwarded: what NARROW proved
  // is what the vendor runs.
  const offScope = traversalDenial(state.fields);
  if (offScope !== undefined) return deny(offScope);

  const postCheck = state.postCheck;
  const rewrites =
    state.fieldsChanged ||
    state.variablesChanged ||
    resolved.inlined === true ||
    payload.carriesExtensions;
  if (!rewrites) {
    return postCheck === undefined
      ? { decision: "allow" }
      : { decision: "allow", postCheck };
  }
  const next = forwardRecord(
    payload,
    rebuild(operation, state.fields),
    state.variablesChanged ? state.variables : undefined,
  );
  const rewritten = JSON.stringify(next);
  return postCheck === undefined
    ? { decision: "allow", body: rewritten }
    : { decision: "allow", body: rewritten, postCheck };
}
