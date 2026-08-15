import type { PaginationRule } from "@missura/core";
import { isRecord, recountTo } from "./filter-json";
import type { IncomingShape } from "./transport";

/**
 * The shape half of the REFILL: reading a page of a collection out of a
 * response, and writing a cursor into the next request. No policy here — these
 * decide shape, never allow or deny. Everything rebuilds instead of mutating,
 * for the same reason the filter does: the parsed body is shared.
 *
 * `undefined` means "a shape we did not expect" everywhere in this file. The
 * caller turns that into "return what we already have", never into a guess.
 */

/** One vendor page, once we could prove it has the shape the rule describes. */
export interface VendorPage {
  root: Record<string, unknown>;
  connection: Record<string, unknown>;
  nodes: readonly unknown[];
  pageInfo: Record<string, unknown>;
  hasNextPage: boolean;
  /** Absent when the vendor gave no usable cursor: the walk stops there. */
  endCursor: string | undefined;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Rebuilds `root` with `value` at `path`. Every step must already exist. */
function replaceAt(
  root: unknown,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> | undefined {
  const [head, ...rest] = path;
  // An empty path would mean "replace the whole container", which no rule can
  // legitimately ask for here — it fails closed instead of rewriting the body.
  if (head === undefined || !isRecord(root)) return undefined;
  if (!Object.hasOwn(root, head)) return undefined;
  if (rest.length === 0) return { ...root, [head]: value };
  const child = replaceAt(root[head], rest, value);
  if (child === undefined) return undefined;
  return { ...root, [head]: child };
}

function text(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

/**
 * A page, or `undefined` if the body is not the collection the rule promised.
 *
 * `hasNextPage` / `endCursor` are the Relay connection spelling, which is what
 * `PaginationRule.pageInfo` points at. A vendor that spells them otherwise is
 * one whose connector must not emit a `pagination` rule at all: the answer here
 * is a short page, never an invented one.
 */
export function readPage(
  body: string | Uint8Array,
  rule: PaginationRule,
): VendorPage | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text(body));
  } catch {
    return undefined;
  }
  if (!isRecord(root)) return undefined;
  const connection = valueAt(root, rule.path);
  if (!isRecord(connection)) return undefined;
  const nodes = connection[rule.nodes];
  if (!Array.isArray(nodes)) return undefined;
  const pageInfo = valueAt(connection, rule.pageInfo);
  if (!isRecord(pageInfo)) return undefined;
  const hasNextPage = pageInfo.hasNextPage;
  if (typeof hasNextPage !== "boolean") return undefined;
  const endCursor = pageInfo.endCursor;
  return {
    root,
    connection,
    nodes,
    pageInfo,
    hasNextPage,
    endCursor:
      typeof endCursor === "string" && endCursor.length > 0
        ? endCursor
        : undefined,
  };
}

function writeLeaf(
  root: unknown,
  path: readonly string[],
  value: string,
): Record<string, unknown> | undefined {
  const [head, ...rest] = path;
  if (head === undefined || !isRecord(root)) return undefined;
  // The leaf itself may be absent — a first page carries no cursor — but every
  // parent must exist: the proxy writes a value into the connector's request,
  // it never invents a request shape.
  if (rest.length === 0) return { ...root, [head]: value };
  if (!Object.hasOwn(root, head)) return undefined;
  const child = writeLeaf(root[head], rest, value);
  if (child === undefined) return undefined;
  return { ...root, [head]: child };
}

/**
 * The same request, one page further: the narrowed body with the vendor's
 * cursor written where the connector said its document reads it. Anything else
 * about the request — path, headers, method — is untouched, so the extra call
 * is the agent's own query and gets the agent's own narrowing.
 */
export function withCursor(
  req: IncomingShape,
  rule: PaginationRule,
  cursor: string,
): IncomingShape | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return undefined;
  }
  const next = writeLeaf(parsed, rule.cursorPath, cursor);
  if (next === undefined) return undefined;
  return { ...req, body: JSON.stringify(next) };
}

/**
 * The merged answer: the first page's body, with our nodes, our page info and
 * counts that describe what WE return.
 *
 * It is built from the FIRST page on purpose — key order, and every field of
 * the collection we did not touch, come from the page the agent would have got
 * anyway. A body assembled from the last page walked would differ from an
 * unwalked one in ways that have nothing to do with the objects it carries.
 */
export function mergedBody(
  first: VendorPage,
  rule: PaginationRule,
  nodes: readonly unknown[],
  pageInfo: Record<string, unknown>,
): string | undefined {
  const connection = recountTo(
    { ...first.connection, [rule.nodes]: nodes },
    nodes.length,
  );
  const merged = replaceAt(connection, rule.pageInfo, pageInfo);
  if (merged === undefined) return undefined;
  const root = replaceAt(first.root, rule.path, merged);
  return root === undefined ? undefined : JSON.stringify(root);
}
