import type { Provider } from "./events";
import type { DenialCode, MissuraDenial } from "./remediation-types";

/**
 * Which vendor SHAPE a refusal travels in. Nothing here decides anything: it
 * wraps a denial the caller already built.
 */

/**
 * Linear's own `extensions.type` vocabulary, so the SDK builds one of ITS
 * typed errors (`AuthenticationLinearError`, `ForbiddenLinearError`…) instead
 * of falling back to an unknown one. Every value here is a function of the
 * denial code, and every denial code is decided from the mission or from
 * missura itself — so the type can never vary with whether a target exists.
 */
const LINEAR_ERROR_TYPE: Record<DenialCode, string> = {
  missura_unauthenticated: "AuthenticationError",
  missura_mission_expired: "AuthenticationError",
  missura_mission_revoked: "AuthenticationError",
  missura_connection_not_in_mission: "Forbidden",
  missura_action_not_allowed: "Forbidden",
  missura_operation_not_in_catalog: "Forbidden",
  missura_out_of_mission_scope: "Forbidden",
  missura_invalid_target: "Forbidden",
  missura_request_too_large: "InvalidInput",
  missura_response_too_large: "Forbidden",
  missura_upstream_error: "NetworkError",
  missura_internal: "InternalError",
};

/**
 * The refusal in the shape the vendor's own SDK parses, with the missura block
 * riding along — in addition to the vendor envelope, never instead of it
 * (SPEC §12). An error the SDK cannot parse is worse than useless to an agent:
 * it surfaces as a transport failure and the remediation never reaches it.
 *
 * `vendorMessage` pins the top-level message where fidelity matters more than
 * detail — a scope refusal answers GitHub's own "Not Found", so that a repo
 * outside the mission and a repo that never existed answer the same bytes, and
 * the detail moves into the block.
 */
export function vendorDenialBody(
  provider: Provider,
  denial: MissuraDenial,
  vendorMessage?: string,
): string {
  const message = vendorMessage ?? denial.reason;
  if (provider === "linear") {
    return JSON.stringify({
      errors: [
        {
          message,
          extensions: {
            type: LINEAR_ERROR_TYPE[denial.code],
            // What `@linear/sdk` picks as `error.errors[0].message`: the agent's
            // most visible string is therefore the remediation, not just the
            // complaint. An error handed to an agent is a prompt (§4.8bis).
            userPresentableMessage: `${message} — ${denial.remediation}`,
            missura: denial,
          },
        },
      ],
    });
  }
  return JSON.stringify({ message, missura: denial });
}
