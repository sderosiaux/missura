import {
  missionIntrospection,
  type CatalogDecision,
  type MissionClaims,
} from "@missura/core";
import { JSON_HEADERS, type IncomingShape, type ResponseShape } from "./transport";

/**
 * The agent-facing introspection route (SPEC §4.8): `GET /missura/mission`,
 * bearer-authenticated with the mission token itself.
 *
 * WHICH LISTENER, and why this one. It is served by the DATA PLANE — every
 * connector listener, through the one pipeline — and not by the operator
 * plane or a listener of its own:
 *
 *   - The operator plane authenticates the operator key before it routes
 *     anything, and an agent never holds that key. Teaching that plane a
 *     second bearer scheme would put the agent's credential on the port that
 *     mints, which is the wrong direction for a boundary to grow.
 *   - The data plane already authenticates exactly this token, already refuses
 *     a bad one in the vendor's own envelope, and already writes the audit
 *     record. A fourth listener would need a fourth port to explain and a
 *     refusal envelope of its own — a new error shape for the one route whose
 *     callers are, by definition, agents that parse errors badly.
 *
 * The pipeline answers it BEFORE the connection check, because the mission
 * that most needs to ask is the one this listener is not in. And it answers
 * from the claims alone (`missionIntrospection`): nothing here reads the
 * mission store, the entity graph, or the vendor, so nothing here can leak
 * what those know and the token does not.
 *
 * The path is one no vendor route can spell: Linear serves `/graphql` only,
 * Zendesk lives under `/api/v2/`, and no GitHub route starts with `/missura`.
 * It is matched on the exact path with the query string dropped; any other
 * method on it is a vendor request and the catalog decides.
 */
export const INTROSPECTION_PATH = "/missura/mission";

/** The audit line: a decision like any other, never silent. */
export const INTROSPECTION_VERDICT: CatalogDecision = {
  decision: "allow",
  operation: "missura.mission",
  action: "introspect",
  reason: "mission introspection",
};

export function isIntrospection(req: IncomingShape): boolean {
  if (req.method.toUpperCase() !== "GET") return false;
  return (req.path.split("?")[0] ?? "") === INTROSPECTION_PATH;
}

export function introspectionResponse(
  claims: MissionClaims,
  now: number,
): ResponseShape {
  return {
    status: 200,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(missionIntrospection(claims, now)),
  };
}
