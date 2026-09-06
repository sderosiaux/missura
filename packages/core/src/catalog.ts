import type { Decision } from "./events";

/**
 * The verdict a connector catalog returns for one inbound request. Shared by
 * every connector (GraphQL or REST) so the proxy pipeline stays provider
 * agnostic. `reason` is always specific enough to debug a denial from the log
 * alone — deny by default means the reason is the only breadcrumb.
 */
export interface CatalogDecision {
  decision: Decision;
  operation: string;
  action: string;
  reason: string;
}

/**
 * The operation an inner call serves (M7/M8). It exists ONLY on requests the
 * operation executor builds in-process and hands to the pipeline itself: the
 * listener reads method, path, headers and body off the wire and nothing
 * else, so no request from outside can carry one, whatever headers it sends.
 * A route that exists only under it is therefore unreachable from the wire
 * by construction — which is how the write routes are gated.
 */
export interface ViaOperation {
  operation: string;
}

/** What a catalog and a NARROW decide on: the request, and where it came from. */
export interface CatalogRequest {
  method: string;
  path: string;
  body: string;
  via?: ViaOperation;
}
