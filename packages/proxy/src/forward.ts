import type { CatalogDecision } from "@missura/core";
import {
  emitEvent,
  TOO_LARGE_REASON,
  type AuditDeps,
  type RequestContext,
} from "./audit";
import {
  applyPostCheck,
  OUT_OF_SCOPE_REASON,
  type NarrowPostCheck,
} from "./narrow";
import {
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
 * The only place the vendor credential is used, and the only place a vendor
 * answer becomes ours: the response is capped, header-filtered and, when the
 * connector registered one, post-checked before it reaches the agent.
 */
export async function forward(
  deps: ForwardDeps,
  target: URL,
  req: IncomingShape,
  verdict: CatalogDecision,
  ctx: RequestContext,
  postCheck?: NarrowPostCheck,
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
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  if (postCheck !== undefined) {
    const checked = applyPostCheck(
      postCheck,
      new TextDecoder().decode(payload),
    );
    if (!checked.ok) {
      emitEvent(
        deps,
        ctx,
        { ...verdict, decision: "deny", reason: OUT_OF_SCOPE_REASON },
        OUT_OF_SCOPE_REASON,
      );
      return {
        status: response.status,
        headers: { ...JSON_HEADERS },
        body: checked.body,
      };
    }
    emitEvent(deps, ctx, verdict);
    return { status: response.status, headers, body: checked.body };
  }

  emitEvent(deps, ctx, verdict);
  return { status: response.status, headers, body: payload };
}
