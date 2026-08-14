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
