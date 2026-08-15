import type { Provider } from "./events";
import type { MissionClaims } from "./token";

/**
 * What a refusal IS, as data (SPEC §4.8bis). The three seams of an actionable
 * denial are kept apart on purpose: this file says what one is made of,
 * `remediation-text.ts` says what it tells the agent, and
 * `remediation-envelope.ts` says which vendor shape it travels in. Only the
 * middle one is allowed to be opinionated.
 */

export type DenialCode =
  | "missura_unauthenticated"
  | "missura_mission_expired"
  | "missura_mission_revoked"
  | "missura_connection_not_in_mission"
  | "missura_action_not_allowed"
  | "missura_operation_not_in_catalog"
  | "missura_out_of_mission_scope"
  | "missura_invalid_target"
  | "missura_request_too_large"
  | "missura_response_too_large"
  | "missura_upstream_error"
  | "missura_internal";

/** The mission as the agent may be told about it — its own grant, nothing else. */
export interface MissionSummary {
  scope: string;
  allowed_actions: readonly string[];
  /** Seconds left, floored at 0: a negative lifetime is not a fact. */
  expires_in: number;
}

export interface MissuraDenial {
  code: DenialCode;
  reason: string;
  /** Absent when no signature-verified mission exists to describe. */
  mission?: MissionSummary;
  remediation: string;
  try_instead: readonly string[];
  introspect: string;
}

export interface DenialInput {
  code: DenialCode;
  /** Diagnostic text. Must already be free of any denied identifier. */
  reason: string;
  provider: Provider;
  /**
   * Only ever signature-verified claims — an unverified token describes
   * nothing. Explicitly `| undefined` so a caller can pass "no mission here"
   * without building the object twice.
   */
  claims?: MissionClaims | undefined;
  now?: number | undefined;
  /**
   * How many targets the mission resolves to for this connector — never which.
   * The count is a property of the agent's own grant; the list is not, because
   * it is resolved from the entity map and the token does not carry it.
   */
  scopeSize?: number | undefined;
  /** The action THIS call needed, read off the catalog verdict (the agent's own request). */
  requiredAction?: string | undefined;
}
