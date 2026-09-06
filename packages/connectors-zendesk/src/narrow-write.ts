import type { ViaOperation } from "@missura/core";
import { decideZendesk } from "./catalog";
import { isVendorId, type CanonicalRequest } from "./narrow-path";
import { singlePlan, ticketProof } from "./narrow-plan";
import {
  deny,
  NOT_IN_CATALOG_SCOPE,
  type ZendeskNarrowResult,
} from "./narrow-result";

/**
 * NARROW for the one write (M10): a ticket update, the inner call of
 * `zendesk.ticket.reply`.
 *
 * A read on a ticket by id is let through and its answer proven, because a
 * foreign ticket can be turned into Zendesk's own not-found on the way back.
 * A write cannot be un-posted, so the proof runs BEFORE: the same parent
 * proof a ticket's comments already need — one GET of the ticket, its
 * `organization_id` against the mission's — and the PUT leaves only once it
 * held. That probe is a read the mission may make anyway; the write itself
 * never leaves for a ticket that is not the mission's, and a foreign ticket
 * and one that never existed refuse identically.
 */

/**
 * The request behind the path: its method, and the operation it serves when
 * it is an inner call. Defaulted to a raw GET, so a caller that says nothing
 * gets the read-only catalog, never the wider one.
 */
export interface ZendeskRequestOrigin {
  method: string;
  via?: ViaOperation;
}

export const RAW_GET: ZendeskRequestOrigin = { method: "GET" };

/**
 * Every write is decided here, and only the one shape gets through: PUT on
 * `/api/v2/tickets/{id}`, re-shown to the catalog with the request's own
 * method and origin so a write off the wire, or under an operation that
 * plans something else, stays refused. The query string is dropped: nothing
 * on it belongs to an update.
 */
export function narrowWrite(
  canonical: CanonicalRequest,
  organizationIds: readonly string[],
  origin: ZendeskRequestOrigin,
): ZendeskNarrowResult {
  const [api, version, resource, id, tail] = canonical.segments;
  if (
    api !== "api" ||
    version !== "v2" ||
    resource !== "tickets" ||
    id === undefined ||
    !isVendorId(id) ||
    tail !== undefined ||
    decideZendesk(origin.method, canonical.path, origin.via).decision === "deny"
  ) {
    return deny(NOT_IN_CATALOG_SCOPE, "missura_operation_not_in_catalog");
  }
  return {
    decision: "allow",
    path: canonical.path,
    denyShape: "zendesk404",
    // The updated ticket comes back whole, organization included: proven
    // on the way back too, like a read of it.
    filterPlan: singlePlan("ticket", "ticket", organizationIds),
    parentProof: ticketProof(id),
    missionOwnerIds: [...organizationIds],
  };
}
