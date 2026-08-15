import type { Provider } from "./events";
import type { MissionClaims, MissionScope } from "./token";

/**
 * Actionable denials (SPEC §4.8bis). An error handed to an agent IS a prompt:
 * a diagnostic refusal ("field `team` is outside the traversal allowlist")
 * makes it loop or invent a workaround, an actionable one makes it correct
 * itself in a single turn. So every refusal carries, next to the vendor shape
 * the SDK parses, a block that says what the mission covers and what to do.
 *
 * NON-LEAK RULE, non-negotiable: everything in that block is derived from the
 * mission the agent ALREADY holds, or from the request it wrote itself. Never
 * from the denied target. "Your mission covers customer:acme — drop `team`" is
 * allowed; "ISS-12 belongs to globex" is not, because it confirms an
 * out-of-scope object exists and turns our errors into an enumeration oracle.
 *
 * The corollary is the one that constrains the text: a remediation must read
 * the same whether the denied target exists or not. That is why the GitHub
 * scope remediation counts the mission's repos instead of saying anything at
 * all about the one that was refused — "not in your 3" is true for a repo that
 * exists and for a repo that never did.
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

/**
 * Honest by construction: §4.8 introspection is M5 work, so this field names
 * the plan and says it is not there yet. A remediation that told an agent to
 * call `get_mission` today would send it at a tool that does not exist — the
 * exact hallucinated-workaround failure actionable errors exist to prevent.
 */
const INTROSPECT =
  "not available yet (planned, SPEC §4.8: mcp get_mission / check_access) — this mission block is the whole boundary";

/** Runnable in-scope shapes. Each needs no identifier the agent has to guess. */
const LINEAR_READ = "query { issues(first: 20) { nodes { id title } } }";
const LINEAR_SMALL = "query { issues(first: 10) { nodes { id title } } }";
const GITHUB_SEARCH = "GET /search/issues?q=<your terms>";
const GITHUB_SMALL = "GET /search/issues?q=<your terms>&per_page=10";

/**
 * The business scope, counted rather than enumerated. One rule, no case
 * analysis: no code path here can be talked into naming a target, whether it
 * came from the mission or from the request.
 */
export function scopeLabel(scope: MissionScope): string {
  const parts: string[] = [];
  if (scope.customer !== undefined && scope.customer !== "") {
    parts.push(`customer:${scope.customer}`);
  }
  if (scope.repos !== undefined && scope.repos.length > 0) {
    parts.push(`repos:${String(scope.repos.length)}`);
  }
  return parts.length === 0 ? "unscoped" : parts.join(" ");
}

export function missionSummary(
  claims: MissionClaims,
  now: number = Date.now(),
): MissionSummary {
  return {
    scope: scopeLabel(claims.scope),
    allowed_actions: [...claims.allow],
    expires_in: Math.max(0, claims.exp - Math.floor(now / 1000)),
  };
}

/**
 * The FIELD a denial reason refused, by the connectors' own convention: a
 * reason about a field opens with it (`field \`team\` (…)`, `root field
 * \`projects\` is not narrowable…`). Quoting it back is what turns "something
 * in your query" into "drop this field", and it leaks nothing — the agent
 * wrote it.
 *
 * Deliberately anchored rather than "first backticked token anywhere": plenty
 * of reasons quote something that is NOT a removable field ("fragment inside
 * the `issue` selection"), and telling an agent to drop a thing it cannot drop
 * costs it the turn the remediation exists to save.
 */
function fieldOf(reason: string): string | undefined {
  return /^(?:root )?field `([^`]+)`/.exec(reason)?.[1];
}

interface Ctx {
  provider: Provider;
  scope: string;
  actions: readonly string[];
  connections: readonly string[];
  scopeSize: number | undefined;
  requiredAction: string | undefined;
  field: string | undefined;
}

function isLinear(ctx: Ctx): boolean {
  return ctx.provider === "linear";
}

/**
 * Identical for a target that exists and for one that never did: the count is
 * the mission's, the alternative needs no name, and nothing here is a function
 * of what was refused.
 */
function outOfScope(ctx: Ctx): string {
  if (isLinear(ctx)) {
    const head =
      ctx.field === undefined
        ? "remove or reshape the part of the request `reason` names"
        : `drop \`${ctx.field}\` from the selection`;
    return `your mission covers ${ctx.scope} — ${head}, or reach it through an object already in scope. An \`issues\` query needs no filter of yours: missura narrows it to your mission.`;
  }
  const repos =
    ctx.scopeSize === undefined
      ? `your mission covers ${ctx.scope}`
      : `your mission covers ${String(ctx.scopeSize)} repositor${ctx.scopeSize === 1 ? "y" : "ies"}`;
  return `${repos}, and this path names one that is not among them. Target a repository your mission covers, or search instead: missura forces your mission's repositories into \`/search/issues\`, so a search needs no repository name.`;
}

function remediationFor(code: DenialCode, ctx: Ctx): string {
  switch (code) {
    case "missura_unauthenticated":
      return "send the mission token on every call as `Authorization: Bearer <token>` — the operator put it in `MISSION_TOKEN`. No token, or one this proxy cannot verify, is refused before any policy runs.";
    case "missura_mission_expired":
      return `this mission (${ctx.scope}) has expired — missions are short-lived by design and nothing in the request can extend one. Ask the operator that started this run for a new mission token.`;
    case "missura_mission_revoked":
      return `this mission (${ctx.scope}) was revoked by its operator and will not work again. Retrying or reshaping the request cannot help: ask the operator for a new mission token.`;
    case "missura_connection_not_in_mission":
      return `your mission covers the ${ctx.connections.join(", ")} connection(s) and this call went to ${ctx.provider}. Send it to a connection the mission covers, or ask the operator for a mission that includes ${ctx.provider}.`;
    case "missura_action_not_allowed":
      return `your mission allows ${ctx.actions.join(", ")}${ctx.requiredAction === undefined ? "" : `, and this call needs \`${ctx.requiredAction}\``}. Re-issue it as one of the allowed actions, or ask the operator for a mission that grants the one you need.`;
    case "missura_operation_not_in_catalog":
      return `this endpoint is not in missura's ${ctx.provider} catalog, so no mission can reach it — a wider mission would not change that. Use a cataloged read or search route instead.`;
    case "missura_out_of_mission_scope":
      return outOfScope(ctx);
    case "missura_invalid_target":
      return `the request target must be a path on this connection's own base URL — an absolute or protocol-relative URL is refused before anything is sent. Re-issue it as a path.`;
    case "missura_request_too_large":
      return `the request body crossed missura's 10 MB cap and was refused before any policy ran. Send a smaller document — split the batch, or drop what the answer does not need.`;
    case "missura_response_too_large":
      return `the vendor's answer crossed missura's 10 MB cap, so none of it is served. Ask for fewer objects — a smaller page and a narrower selection — and the same call goes through.`;
    case "missura_upstream_error":
      return `the vendor could not be reached, so no decision about your mission was involved. Retry with backoff; if it persists, tell the operator — this is not something the request can fix.`;
    case "missura_internal":
      return `missura failed while deciding this request and fails closed rather than forwarding it. Retry once; if it persists, tell the operator — nothing about the request is at fault.`;
  }
}

function tryInsteadFor(code: DenialCode, ctx: Ctx): readonly string[] {
  switch (code) {
    // Nothing about the request fixes an identity or availability problem, so
    // nothing is suggested: a shape that cannot work is worse than none.
    case "missura_unauthenticated":
    case "missura_mission_expired":
    case "missura_mission_revoked":
    case "missura_connection_not_in_mission":
    case "missura_upstream_error":
    case "missura_internal":
      return [];
    case "missura_request_too_large":
    case "missura_response_too_large":
      return isLinear(ctx) ? [LINEAR_SMALL] : [GITHUB_SMALL];
    case "missura_invalid_target":
      return isLinear(ctx) ? ["POST /graphql"] : [GITHUB_SEARCH];
    default:
      return isLinear(ctx) ? [LINEAR_READ] : [GITHUB_SEARCH];
  }
}

export function buildDenial(input: DenialInput): MissuraDenial {
  const mission =
    input.claims === undefined
      ? undefined
      : missionSummary(input.claims, input.now);
  const ctx: Ctx = {
    provider: input.provider,
    scope: mission?.scope ?? "no verified mission",
    actions: mission?.allowed_actions ?? [],
    connections: input.claims?.connections ?? [],
    scopeSize: input.scopeSize,
    requiredAction: input.requiredAction,
    field: fieldOf(input.reason),
  };
  return {
    code: input.code,
    reason: input.reason,
    ...(mission === undefined ? {} : { mission }),
    remediation: remediationFor(input.code, ctx),
    try_instead: tryInsteadFor(input.code, ctx),
    introspect: INTROSPECT,
  };
}

/**
 * The refusal in the shape the vendor's own SDK parses, with the missura block
 * riding along — in addition to the vendor envelope, never instead of it
 * (SPEC §12). An error the SDK cannot parse is worse than useless to an agent:
 * it surfaces as a transport failure and the remediation never reaches it.
 *
 * `vendorMessage` pins the top-level message where fidelity matters more than
 * detail — a scope refusal answers GitHub's own "Not Found", so that it stays
 * indistinguishable from absence, and the detail moves into the block.
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
