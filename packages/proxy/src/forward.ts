import type { CatalogDecision } from "@missura/core";
import {
  emitEvent,
  TOO_LARGE_REASON,
  type AuditDeps,
  type RequestContext,
} from "./audit";
import { applyFilterPlan, type FilterTask } from "./filter";
import {
  FILTER_INVALIDATED_RESPONSE_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  hasBody,
  jsonError,
  JSON_HEADERS,
  readCapped,
  upstreamHeaders,
  type IncomingShape,
  type ResponseShape,
} from "./transport";

/** What talking to the vendor needs: the credential, the origin, a fetch. */
export interface ForwardDeps extends AuditDeps {
  /** The vendor credential, read from the vault once at boot — never logged. */
  vendorAuthHeader(): string;
  upstreamBase: string;
  fetchImpl: typeof fetch;
}

/**
 * Resolves the request target against the upstream base instead of
 * concatenating it. A client may send an absolute (`https://evil.com/x`) or
 * protocol-relative (`//evil.com/x`) request target; string concatenation
 * would hand that origin the injected vendor credential. Anything that does
 * not resolve back onto the upstream origin is refused.
 */
export function upstreamTarget(
  deps: ForwardDeps,
  path: string,
): URL | undefined {
  let url: URL;
  try {
    url = new URL(path, deps.upstreamBase);
    if (url.origin !== new URL(deps.upstreamBase).origin) return undefined;
  } catch {
    return undefined;
  }
  return url;
}

/**
 * The vendor headers the agent is allowed to see, minus the ones a filter plan
 * invalidates. `filtered` is "a plan applied to this response", not "the plan
 * removed something": a header that appears only on untouched pages tells the
 * agent which pages held objects it may not see.
 */
function relayedHeaders(
  response: Response,
  filtered: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    if (filtered && FILTER_INVALIDATED_RESPONSE_HEADERS.has(name)) continue;
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

/**
 * A refusal produced on the way back keeps the headers an answer would have
 * carried. Relaying the rate-limit budget on the ALLOW and dropping it here
 * would make the headers themselves the tell — "no budget, no request id" then
 * reads as "the page I asked for held objects I may not see", which is the
 * enumeration the vendor-shaped body exists to prevent.
 *
 * Only the content-type is reconsidered: the body is now OUR JSON, so a vendor
 * content-type that does not announce JSON would be a lie. When it does
 * announce JSON, its exact spelling is kept — `application/json` where the
 * vendor said `application/json; charset=utf-8` is one more difference between
 * a refusal and an answer.
 */
function refusalHeaders(
  relayed: Record<string, string>,
): Record<string, string> {
  const declared = relayed["content-type"]?.toLowerCase() ?? "";
  return declared.includes("application/json")
    ? relayed
    : { ...relayed, ...JSON_HEADERS };
}

/**
 * The only place the vendor credential is used, and the only place a vendor
 * answer becomes ours: the response is capped, header-filtered and, when the
 * connector registered a plan, FILTERED before it reaches the agent.
 */
export async function forward(
  deps: ForwardDeps,
  target: URL,
  req: IncomingShape,
  verdict: CatalogDecision,
  ctx: RequestContext,
  filter?: FilterTask,
): Promise<ResponseShape> {
  let response: Response;
  try {
    // Origin + the normalized target only: never the raw client path, and
    // never a fragment (which does not belong on the wire).
    const url = `${target.origin}${target.pathname}${target.search}`;
    response = await deps.fetchImpl(url, {
      method: req.method,
      headers: upstreamHeaders(req.headers, deps.vendorAuthHeader()),
      ...(hasBody(req.method) && req.body.length > 0 ? { body: req.body } : {}),
    });
  } catch {
    // The upstream error is deliberately swallowed: its message can carry the
    // vendor host, and an injected credential could surface in a wrapped error.
    emitEvent(deps, ctx, verdict, "upstream_error");
    return jsonError(502, "missura_upstream_error");
  }

  const payload = await readCapped(response);
  if (payload === undefined) {
    // The vendor was reached, so the record says so — the request is denied
    // on the way back, not on the way out.
    emitEvent(
      deps,
      ctx,
      { ...verdict, decision: "deny", reason: TOO_LARGE_REASON },
      TOO_LARGE_REASON,
    );
    return jsonError(502, "missura_response_too_large");
  }
  const headers = relayedHeaders(response, filter !== undefined);

  if (filter !== undefined) {
    const filtered = applyFilterPlan(
      filter.plan,
      new TextDecoder().decode(payload),
      filter.notFoundBody,
    );
    if (!filtered.ok) {
      // The vendor answered, so the record says so — the request is refused on
      // the way back, and the agent sees the vendor's own "not found".
      emitEvent(
        deps,
        ctx,
        { ...verdict, decision: "deny", reason: filter.denyReason },
        filter.denyReason,
      );
      return {
        status: response.status,
        headers: refusalHeaders(headers),
        body: filtered.body,
      };
    }
    // How many objects the mission was not allowed to see is part of the
    // record: an ALLOW that removed objects is not the same event as one that
    // had nothing to remove.
    emitEvent(deps, ctx, verdict, undefined, filtered.objectsRemoved);
    return { status: response.status, headers, body: filtered.body };
  }

  emitEvent(deps, ctx, verdict);
  return { status: response.status, headers, body: payload };
}
