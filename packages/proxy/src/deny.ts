import {
  buildDenial,
  vendorDenialBody,
  type DenialInput,
  type MissionClaims,
  type Provider,
} from "@missura/core";
import { ACTION_REASON, CONNECTION_REASON } from "./audit";
import { JSON_HEADERS, type ResponseShape } from "./transport";

/**
 * One place where a refusal becomes bytes. Every deny path in the pipeline
 * goes through here, so the vendor envelope, the missura block and the header
 * treatment cannot drift apart between them — and a new deny path cannot ship
 * as a bare 403 by forgetting to build one.
 *
 * The status is the caller's: it is part of the vendor contract (GitHub's 404
 * for absence, 401 for identity), not something a remediation gets to choose.
 */
export interface DenialOptions extends Omit<DenialInput, "provider"> {
  status: number;
  /**
   * Pins the vendor's own top-level message where fidelity beats detail: a
   * scope refusal answers GitHub's "Not Found" verbatim, so it stays
   * indistinguishable from an object that never existed, and the explanation
   * moves into the block where it describes the MISSION rather than the target.
   */
  vendorMessage?: string | undefined;
  /**
   * The headers an answer would have carried. A refusal produced after the
   * vendor spoke keeps them (see `forward.ts`): dropping the rate-limit budget
   * only on refusals would make the headers themselves the tell. Before the
   * vendor is reached there is nothing to relay, so JSON alone.
   */
  headers?: Record<string, string> | undefined;
}

/** The verified mission a refusal describes, and the clock it is described at. */
export interface Mission {
  claims: MissionClaims;
  now: number;
}

/**
 * The two claims refusals, built in ONE place for the two callers that decide
 * them: the pipeline, on a raw request, and the operation executor, before it
 * plans one. An operation refused on its connector or its effect must answer
 * the very bytes the raw call would — and "the same function with the same
 * inputs" is the only way that stays true without a test per field.
 */
export function connectionDenial(mission: Mission): DenialOptions {
  return {
    status: 403,
    code: "missura_connection_not_in_mission",
    reason: CONNECTION_REASON,
    ...mission,
  };
}

export function actionDenial(
  mission: Mission,
  requiredAction: string,
): DenialOptions {
  return {
    status: 403,
    code: "missura_action_not_allowed",
    reason: ACTION_REASON,
    requiredAction,
    ...mission,
  };
}

export function denialResponse(
  provider: Provider,
  options: DenialOptions,
): ResponseShape {
  const { status, vendorMessage, headers, ...input } = options;
  const denial = buildDenial({ ...input, provider });
  return {
    status,
    headers: headers ?? { ...JSON_HEADERS },
    body: vendorDenialBody(provider, denial, vendorMessage),
  };
}
