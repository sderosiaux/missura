import type { CatalogDecision } from "@missura/core";
import {
  Kind,
  OperationTypeNode,
  parse,
  type DocumentNode,
  type OperationDefinitionNode,
} from "graphql";

/**
 * Root fields M1 is allowed to read on the Linear GraphQL API. Deny by
 * default: anything absent from this list is refused, whatever it looks like.
 */
const ALLOWED_ROOT_FIELDS: ReadonlySet<string> = new Set([
  "issues",
  "issue",
  "customers",
  "customer",
  "projects",
  "project",
  "comments",
  "comment",
  "viewer",
]);

const ACTION_BY_OPERATION_TYPE: Record<OperationTypeNode, string> = {
  query: "read",
  mutation: "write",
  subscription: "subscribe",
};

function deny(reason: string, operation = "unknown", action = "unknown"): CatalogDecision {
  return { decision: "deny", operation, action, reason };
}

function parseBody(body: string): { query: string } | CatalogDecision {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return deny("request body is not JSON — expected a GraphQL POST payload");
  }
  if (typeof payload !== "object" || payload === null) {
    return deny("request body is not JSON — expected a GraphQL POST payload");
  }
  const query: unknown = (payload as Record<string, unknown>).query;
  if (typeof query !== "string") {
    return deny("request body has no string `query` field");
  }
  return { query };
}

function singleOperation(doc: DocumentNode): OperationDefinitionNode | CatalogDecision {
  const operations = doc.definitions.filter(
    (def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION,
  );
  const first = operations[0];
  if (first === undefined) {
    return deny("document contains no operation — only fragment definitions");
  }
  if (operations.length > 1) {
    return deny(
      `document contains ${String(operations.length)} operations — exactly one is allowed`,
    );
  }
  return first;
}

function isDecision(value: object): value is CatalogDecision {
  return "decision" in value;
}

/**
 * Decide whether a raw Linear `/graphql` POST body may reach the vendor.
 * Read-only, single-operation, allowlisted root fields — every other shape is
 * denied with a reason naming the exact field or operation type at fault.
 */
export function decideLinear(body: string): CatalogDecision {
  const parsedBody = parseBody(body);
  if (isDecision(parsedBody)) return parsedBody;

  let doc: DocumentNode;
  try {
    doc = parse(parsedBody.query, { noLocation: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "syntax error";
    return deny(`unparseable GraphQL document: ${detail}`);
  }

  const operation = singleOperation(doc);
  if (isDecision(operation)) return operation;

  const action = ACTION_BY_OPERATION_TYPE[operation.operation];
  const name = operation.name?.value;
  if (operation.operation !== OperationTypeNode.QUERY) {
    return deny(
      `operation type \`${operation.operation}\` is not allowed — the M1 catalog is read-only`,
      name ?? operation.operation,
      action,
    );
  }

  const rootFields: string[] = [];
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      return deny(
        "fragment at root unsupported in M1 — inline the root fields in the query",
        name ?? "unknown",
        action,
      );
    }
    rootFields.push(selection.name.value);
  }

  const operationLabel = name ?? rootFields[0] ?? "unknown";
  for (const field of rootFields) {
    if (field.startsWith("__")) {
      return deny(
        `introspection field \`${field}\` is not allowed`,
        operationLabel,
        action,
      );
    }
    if (!ALLOWED_ROOT_FIELDS.has(field)) {
      return deny(
        `root field \`${field}\` is not in the Linear read catalog`,
        operationLabel,
        action,
      );
    }
  }

  return {
    decision: "allow",
    operation: operationLabel,
    action,
    reason: `read query over allowlisted root fields: ${rootFields.join(", ")}`,
  };
}
