import type { PaginationCursor, PaginationRule } from "@missura/core";
import { isRecord } from "./filter-json";
import type { IncomingShape } from "./transport";

/**
 * The shape half of the REFILL: reading a page of a collection out of a
 * response, and asking the vendor for the one after it. No policy here — these
 * decide shape, never allow or deny. Everything rebuilds instead of mutating,
 * for the same reason the filter does: the parsed body is shared.
 *
 * `undefined` means "a shape we did not expect" everywhere in this file. The
 * caller turns that into "return what we already have", never into a guess.
 */

/** How to ask the vendor for the page after the one we just read. */
export type NextPage =
  | { source: "body-path"; cursor: string }
  | { source: "query-page"; page: number };

/**
 * Where the response being read came from — the two things the body itself can
 * no longer say once the FILTER has been over it.
 */
export interface PageOrigin {
  /** Objects the filter removed from this very response. */
  removed: number;
  /**
   * The position this response was fetched at, or absent for the agent's own
   * first request (the rule already names that one).
   */
  at: NextPage | undefined;
}

/** One vendor page, once we could prove it has the shape the rule describes. */
export interface VendorPage {
  root: Record<string, unknown>;
  connection: Record<string, unknown>;
  nodes: readonly unknown[];
  /** Relay's page info as the vendor sent it; empty under `query-page`. */
  pageInfo: Record<string, unknown>;
  /** The vendor says there may be objects after this page. */
  hasNextPage: boolean;
  /** Absent when there is no usable way to ask for more: the walk stops. */
  next: NextPage | undefined;
}

export function valueAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Rebuilds `root` with `value` at `path`. Every step must already exist. */
export function replaceAt(
  root: unknown,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> | undefined {
  const [head, ...rest] = path;
  // An empty path would mean "replace the whole container", which the callers
  // handle themselves — reaching it here is a rule that names no field.
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
 * The Relay half: `hasNextPage` / `endCursor` inside the page info object the
 * rule points at. A vendor that spells them otherwise is one whose connector
 * must not emit a `pagination` rule at all — the answer here is a short page,
 * never an invented one.
 */
function relayPage(
  connection: Record<string, unknown>,
  cursor: Extract<PaginationCursor, { source: "body-path" }>,
): Pick<VendorPage, "pageInfo" | "hasNextPage" | "next"> | undefined {
  const pageInfo = valueAt(connection, cursor.pageInfo);
  if (!isRecord(pageInfo)) return undefined;
  const hasNextPage = pageInfo.hasNextPage;
  if (typeof hasNextPage !== "boolean") return undefined;
  const endCursor = pageInfo.endCursor;
  const usable = typeof endCursor === "string" && endCursor.length > 0;
  return {
    pageInfo,
    hasNextPage,
    next: usable ? { source: "body-path", cursor: endCursor } : undefined,
  };
}

/**
 * The page-number half. REST publishes no page info, so "is there more" is read
 * off the SIZE of the vendor page — and the size the vendor sent is not the one
 * left in the body, because the filter already removed objects from it. Hence
 * `removed`: `nodes.length + removed` is what the vendor actually answered, and
 * a page shorter than `pageSize` is the last one.
 *
 * Without that count a short page would be unreadable — "the vendor ran out"
 * and "we hid all of it" look identical from the outside, which is the whole
 * point of the filter and exactly why the walk cannot infer it from the body.
 */
function numberedPage(
  nodes: readonly unknown[],
  origin: PageOrigin,
  cursor: Extract<PaginationCursor, { source: "query-page" }>,
): Pick<VendorPage, "pageInfo" | "hasNextPage" | "next"> {
  const served = nodes.length + origin.removed;
  const here =
    origin.at?.source === "query-page" ? origin.at.page : cursor.page;
  return {
    pageInfo: {},
    hasNextPage: served >= cursor.pageSize,
    next: { source: "query-page", page: here + 1 },
  };
}

/**
 * A page, or `undefined` if the body is not the collection the rule promised.
 *
 * `origin` is ignored under `body-path`, where the vendor states `hasNextPage`
 * itself and filtering cannot change it — see `numberedPage` for why the other
 * style cannot do without it.
 */
export function readPage(
  body: string | Uint8Array,
  rule: PaginationRule,
  origin: PageOrigin,
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
  const paging =
    rule.cursor.source === "body-path"
      ? relayPage(connection, rule.cursor)
      : numberedPage(nodes, origin, rule.cursor);
  if (paging === undefined) return undefined;
  return { root, connection, nodes, ...paging };
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

/** The narrowed request body with the vendor's cursor written into it. */
function bodyWithCursor(
  req: IncomingShape,
  path: readonly string[],
  cursor: string,
): IncomingShape | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return undefined;
  }
  const next = writeLeaf(parsed, path, cursor);
  if (next === undefined) return undefined;
  return { ...req, body: JSON.stringify(next) };
}

/**
 * The same request target with one query parameter set to the next page. The
 * base is a placeholder: `req.path` is already the narrowed, origin-checked
 * target, and only its query string is rewritten here.
 */
function targetWithPage(
  req: IncomingShape,
  param: string,
  page: number,
): IncomingShape | undefined {
  let url: URL;
  try {
    url = new URL(req.path, "https://vendor.invalid");
  } catch {
    return undefined;
  }
  url.searchParams.set(param, String(page));
  return { ...req, path: `${url.pathname}${url.search}` };
}

/**
 * The same request, one page further: the narrowed request with the vendor's
 * own idea of "next" written where the connector said it goes. Anything else
 * about it — path, headers, method, the rest of the query — is untouched, so
 * the extra call is the agent's own request and gets the agent's own narrowing.
 */
export function withNext(
  req: IncomingShape,
  rule: PaginationRule,
  next: NextPage,
): IncomingShape | undefined {
  if (rule.cursor.source === "body-path" && next.source === "body-path") {
    return bodyWithCursor(req, rule.cursor.cursorPath, next.cursor);
  }
  if (rule.cursor.source === "query-page" && next.source === "query-page") {
    return targetWithPage(req, rule.cursor.param, next.page);
  }
  return undefined;
}

/**
 * The merged answer: the first page's body, with our nodes and — under Relay —
 * our page info.
 *
 * It is built from the FIRST page on purpose — key order, and every field of
 * the collection we did not touch, come from the page the agent would have got
 * anyway. A body assembled from the last page walked would differ from an
 * unwalked one in ways that have nothing to do with the objects it carries.
 *
 * There is no count to fix up here: the filter already removed every count
 * field next to this list, page by page, before the merge could see one.
 */
export function mergedBody(
  first: VendorPage,
  rule: PaginationRule,
  nodes: readonly unknown[],
  pageInfo: Record<string, unknown>,
): string | undefined {
  const connection = { ...first.connection, [rule.nodes]: nodes };
  const merged =
    rule.cursor.source === "body-path"
      ? replaceAt(connection, rule.cursor.pageInfo, pageInfo)
      : connection;
  if (merged === undefined) return undefined;
  if (rule.path.length === 0) return JSON.stringify(merged);
  const root = replaceAt(first.root, rule.path, merged);
  return root === undefined ? undefined : JSON.stringify(root);
}
