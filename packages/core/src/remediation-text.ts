import type { Provider } from "./events";
import type { DenialCode } from "./remediation-types";

/**
 * What a refusal TELLS the agent. An error handed to an agent IS a prompt: a
 * diagnostic refusal ("field `team` is outside the traversal allowlist") makes
 * it loop or invent a workaround, an actionable one makes it correct itself in
 * a single turn (SPEC §4.8bis).
 *
 * NON-LEAK RULE, non-negotiable: every sentence here is derived from the
 * mission the agent ALREADY holds, or from the request it wrote itself. Never
 * from the denied target. The corollary is what constrains the wording: a
 * remediation must read the same whether the denied target exists or not, which
 * is why the GitHub scope text COUNTS the mission's repos instead of saying
 * anything about the one that was refused — "not among your 3" is equally true
 * for a repo that exists and for a repo that never did.
 */

/**
 * Honest by construction: §4.8 introspection is M5 work, so this field names
 * the plan and says it is not there yet. A remediation that told an agent to
 * call `get_mission` today would send it at a tool that does not exist — the
 * exact hallucinated-workaround failure actionable errors exist to prevent.
 */
export const INTROSPECT =
  "not available yet (planned, SPEC §4.8: mcp get_mission / check_access) — this mission block is the whole boundary";

/** Runnable in-scope shapes. Each needs no identifier the agent has to guess. */
const LINEAR_READ = "query { issues(first: 20) { nodes { id title } } }";
const LINEAR_SMALL = "query { issues(first: 10) { nodes { id title } } }";
const GITHUB_SEARCH = "GET /search/issues?q=<your terms>";
const GITHUB_SMALL = "GET /search/issues?q=<your terms>&per_page=10";
const ZENDESK_SEARCH = "GET /api/v2/search?query=type:ticket <your terms>";
const ZENDESK_SMALL =
  "GET /api/v2/search?query=type:ticket <your terms>&per_page=10";

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
export function fieldOf(reason: string): string | undefined {
  return /^(?:root )?field `([^`]+)`/.exec(reason)?.[1];
}

/** Everything the wording may draw on — and nothing about the denied target. */
export interface Ctx {
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
 * The same shape as the GitHub wording and for the same reason: the COUNT of
 * the mission's organizations is a fact about the agent's own grant, so "not
 * among your 3" is equally true for an organization that exists and for one
 * that never did. The alternative it offers needs no identifier either —
 * missura forces the mission's organizations into the search query, so the
 * agent has nothing to name.
 */
function zendeskOutOfScope(ctx: Ctx): string {
  const orgs =
    ctx.scopeSize === undefined
      ? `your mission covers ${ctx.scope}`
      : `your mission covers ${String(ctx.scopeSize)} organization${ctx.scopeSize === 1 ? "" : "s"}`;
  return `${orgs}, and this request names one that is not among them. Target an organization your mission covers, or search instead: missura forces your mission's organizations into \`GET /api/v2/search\`, so a search needs no \`organization:\` qualifier of yours.`;
}

/**
 * Identical for a target that exists and for one that never did: the count is
 * the mission's, the alternative needs no name, and nothing here is a function
 * of what was refused.
 */
function outOfScope(ctx: Ctx): string {
  if (ctx.provider === "zendesk") return zendeskOutOfScope(ctx);
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

export function remediationFor(code: DenialCode, ctx: Ctx): string {
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

/**
 * The runnable shapes, per connection. One table rather than a chain of
 * ternaries: a new connection that forgets a column is a type error here,
 * where the alternative is silently handing an agent another vendor's syntax.
 */
const SHAPES: Record<
  Provider,
  { read: string; small: string; entry: string }
> = {
  linear: { read: LINEAR_READ, small: LINEAR_SMALL, entry: "POST /graphql" },
  github: { read: GITHUB_SEARCH, small: GITHUB_SMALL, entry: GITHUB_SEARCH },
  zendesk: {
    read: ZENDESK_SEARCH,
    small: ZENDESK_SMALL,
    entry: ZENDESK_SEARCH,
  },
};

export function tryInsteadFor(code: DenialCode, ctx: Ctx): readonly string[] {
  const shape = SHAPES[ctx.provider];
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
      return [shape.small];
    case "missura_invalid_target":
      return [shape.entry];
    default:
      return [shape.read];
  }
}
