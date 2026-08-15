import type { CursorStore, FilterPlan, PaginationRule } from "@missura/core";
import { isRecord } from "./filter-json";
import { replaceAt, valueAt } from "./refill-page";
import type { IncomingShape, ResponseShape } from "./transport";

/**
 * The two places a pagination cursor crosses the boundary, and the only two
 * places the agent and the vendor disagree about what a cursor IS.
 *
 * Outbound (`vendorCursor`): the agent sends back a handle we issued; it is
 * exchanged for the vendor position before the request leaves. A handle we did
 * not issue — or one issued to another mission — is refused rather than
 * forwarded, because a cursor we cannot vouch for resumes the agent somewhere
 * nothing authorized.
 *
 * Inbound (`missuraCursor`): the vendor's position is replaced by a fresh
 * handle before the answer reaches the agent. It runs on EVERY response the
 * rule describes, walked or not — a body that kept the vendor's cursor when no
 * refill happened would make the cursor's format the signal that a walk did.
 *
 * Both are no-ops when the body is not the shape the rule promised. Only
 * `body-path` pagination is touched: a `query-page` cursor is the agent's own
 * page number, which it chose and already knows.
 */

/** Where the vendor's own cursor sits in a response, from the body root. */
function endCursorPath(rule: PaginationRule): readonly string[] | undefined {
  if (rule.cursor.source !== "body-path") return undefined;
  return [...rule.path, ...rule.cursor.pageInfo, "endCursor"];
}

function text(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

/** `undefined` ⇒ the agent sent a handle we cannot vouch for: refuse. */
function vendorCursor(
  body: string,
  rule: PaginationRule,
  missionId: string,
  cursors: CursorStore,
): { body: string } | undefined {
  if (rule.cursor.source !== "body-path") return { body };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body };
  }
  const handle = valueAt(parsed, rule.cursor.cursorPath);
  // No cursor at all is the ordinary first page, and a non-string is not
  // something we issued — the vendor is left to reject it as it would anyway.
  if (typeof handle !== "string" || handle.length === 0) return { body };
  const resolved = cursors.resolve(missionId, handle);
  if (resolved === undefined) return undefined;
  const next = replaceAt(parsed, rule.cursor.cursorPath, resolved);
  if (next === undefined) return { body };
  return { body: JSON.stringify(next) };
}

/** The answer with our handle where the vendor put its position. */
function missuraCursor(
  body: string | Uint8Array,
  rule: PaginationRule,
  missionId: string,
  cursors: CursorStore,
): string | Uint8Array {
  const path = endCursorPath(rule);
  if (path === undefined) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(body));
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;
  const cursor = valueAt(parsed, path);
  if (typeof cursor !== "string" || cursor.length === 0) return body;
  const sealed = replaceAt(parsed, path, cursors.issue(missionId, cursor));
  return sealed === undefined ? body : JSON.stringify(sealed);
}

/**
 * The two stages the pipeline actually calls, so it never has to know the shape
 * of a pagination rule. A plan without one leaves both a no-op.
 */

/** `undefined` ⇒ deny: the agent paginated with a handle that is not its own. */
export function withVendorCursor(
  req: IncomingShape,
  plan: FilterPlan | undefined,
  missionId: string,
  cursors: CursorStore,
): IncomingShape | undefined {
  const rule = plan?.pagination;
  if (rule === undefined) return req;
  const swapped = vendorCursor(req.body, rule, missionId, cursors);
  return swapped === undefined ? undefined : { ...req, body: swapped.body };
}

export function withMissuraCursor(
  res: ResponseShape,
  plan: FilterPlan | undefined,
  missionId: string,
  cursors: CursorStore,
): ResponseShape {
  const rule = plan?.pagination;
  if (rule === undefined) return res;
  return { ...res, body: missuraCursor(res.body, rule, missionId, cursors) };
}
