import type { CatalogDecision, MissionClaims } from "@missura/core";
import type { RequestContext } from "./audit";
import type { FilterTask } from "./filter";
import {
  forward,
  upstreamTarget,
  type ForwardDeps,
  type ForwardOutcome,
} from "./forward";
import { mergedBody, readPage, withNext, type VendorPage } from "./refill-page";
import type { IncomingShape, ResponseShape } from "./transport";

/**
 * Pagination REFILL: the other half of the response FILTER.
 *
 * Filtering a page of 50 down to 12 breaks two things at once. The SDK's
 * pagination helpers stop working — they asked for 50 and got 12 with a cursor
 * that no longer means what it says — and the short page itself announces that
 * 38 objects were hidden. So when the filter leaves a page short and the vendor
 * says there is more, we walk forward and merge until the agent's page is as
 * full as its authorized objects allow.
 *
 * The walk is BOUNDED, because it multiplies the vendor load one agent request
 * can cause: at most `MAX_REFILL_CALLS` extra calls, and never past
 * `REFILL_BUDGET_MS` of total request time. Each extra call goes back through
 * `forward`, so the credential injection, the header allowlist, the response
 * cap, the filter and the audit record all stay in one place — and the audit
 * shows the real number of vendor calls a mission spent.
 *
 * DEFERRED (SPEC §22): missura-owned opaque logical cursors. M3 hands back the
 * last upstream cursor it actually used. Three consequences, all real:
 *   - a cursor is only meaningful against the same mission and the same vendor
 *     page boundaries, so an agent that STORES a cursor and replays it under a
 *     later mission resumes from a vendor position that mission never walked —
 *     it will silently skip or repeat objects;
 *   - when a walk collects more authorized objects than the agent asked for,
 *     the surplus is dropped rather than returned, and the cursor we hand back
 *     points PAST it. Those objects are missing from the agent's next page.
 *     Returning them instead would make the answer longer than the page that
 *     was requested, which is itself a count of how many pages we walked;
 *   - CONFIDENTIALITY, and it is the one that is not merely an availability
 *     cost: that cursor is a vendor POSITION, so it says how far the walk went.
 *     The common `arrayconnection:N` spelling is plain base64, so an agent that
 *     decodes it reads `position_walked − page_size` = objects hidden between
 *     its own page and ours. Everything else about a walked answer is already
 *     indistinguishable (same shape, same key order, the first page's headers);
 *     the cursor is the one field that is not. It is NOT masked because both
 *     ways of masking it break pagination rather than protect it: the first
 *     page's cursor resumes at a vendor position we have already consumed, so
 *     the agent is served the same objects twice, and omitting the cursor stops
 *     the SDK's iteration outright. Pinned by refill-closed.test.ts.
 * All three disappear once the cursor is ours to mint.
 */

/** Extra upstream calls one agent request may cause. */
export const MAX_REFILL_CALLS = 5;
/**
 * Wall-clock budget for the whole request, measured from the moment the proxy
 * received it — the deadline the agent actually experiences, so a slow first
 * page spends the budget it really spent.
 */
export const REFILL_BUDGET_MS = 10_000;

/** Everything an extra call needs, exactly as the first one had it. */
export interface RefillCall {
  /**
   * The narrowed request, exactly as the first call carried it. The upstream
   * TARGET is re-resolved from it on every extra call rather than carried
   * alongside: a page-numbered walk rewrites the query string, so a target
   * fixed at the first call would re-ask for the very page we already have.
   */
  req: IncomingShape;
  verdict: CatalogDecision;
  ctx: RequestContext;
  /** Absent when the connector registered no plan: there is nothing to refill. */
  filter: FilterTask | undefined;
  claims?: MissionClaims;
}

interface Walk {
  nodes: unknown[];
  last: VendorPage;
  /** The vendor told us this collection is finished. */
  exhausted: boolean;
  /** We stopped without being told: a cap, an error, a shape we cannot read. */
  stopped: boolean;
}

function elapsed(deps: ForwardDeps, ctx: RequestContext): number {
  return (deps.now?.() ?? Date.now()) - ctx.startedAt;
}

/**
 * Walks forward until the page is full, the vendor runs out, or a bound is
 * reached. Anything unexpected — an unreachable vendor, a status that is not
 * the first page's, a body we cannot read as this collection — ends the walk
 * as `stopped`, which the caller reports as "there is more". It never ends as
 * "here is everything": a refill that failed must cost objects, never truth.
 */
async function walkPages(
  deps: ForwardDeps,
  call: RefillCall,
  filter: FilterTask,
  first: VendorPage,
  status: number,
  requested: number,
): Promise<Walk> {
  const rule = filter.plan.pagination;
  const walk: Walk = {
    nodes: [...first.nodes],
    last: first,
    exhausted: false,
    stopped: false,
  };
  if (rule === undefined) return walk;
  for (let calls = 0; walk.nodes.length < requested; calls += 1) {
    const after = walk.last.next;
    if (
      calls >= MAX_REFILL_CALLS ||
      elapsed(deps, call.ctx) >= REFILL_BUDGET_MS
    )
      return { ...walk, stopped: true };
    if (after === undefined) return { ...walk, stopped: true };
    const next = withNext(call.req, rule, after);
    if (next === undefined) return { ...walk, stopped: true };
    // Re-resolved from the rewritten target, exactly as the pipeline does after
    // NARROW: the walk shrinks or advances a request, never moves its origin.
    const target = upstreamTarget(deps, next.path);
    if (target === undefined) return { ...walk, stopped: true };
    const res = await forward(
      deps,
      target,
      next,
      call.verdict,
      call.ctx,
      filter,
      call.claims,
    );
    // A refused or failed extra call is not a page: the filter may have failed
    // closed on it, and its body is then the vendor's own not-found.
    if (res.status !== status) return { ...walk, stopped: true };
    const page = readPage(res.body, rule, { removed: res.removed, at: after });
    if (page === undefined) return { ...walk, stopped: true };
    walk.nodes.push(...page.nodes);
    walk.last = page;
    if (!page.hasNextPage) return { ...walk, exhausted: true };
  }
  return walk;
}

/**
 * The page info WE answer with: the first page's, because that is where our
 * result set starts, carrying the only two fields the walk changes.
 *
 * `hasNextPage` is true unless the vendor ran out AND we are handing back
 * everything we collected. Every uncertain case resolves to true — a cap, an
 * error, an unreadable page — because "there may be more" costs the agent one
 * extra call, while a wrong `false` silently ends its iteration early.
 */
function mergedPageInfo(
  walk: Walk,
  first: VendorPage,
  kept: number,
): Record<string, unknown> {
  const hasNextPage =
    walk.stopped || !walk.exhausted || kept < walk.nodes.length;
  const last = walk.last.next;
  return {
    ...first.pageInfo,
    hasNextPage,
    ...(last?.source === "body-path" ? { endCursor: last.cursor } : {}),
  };
}

/**
 * Refills the first page, or returns it untouched.
 *
 * Untouched is the common case and the quiet one: no pagination rule, a page
 * that is already full, a vendor that says there is nothing after it, a body
 * that is not the collection the rule describes. The agent gets the bytes
 * `forward` produced.
 *
 * When the walk does happen, the answer must be indistinguishable from a
 * vendor page that happened to hold exactly these objects: same shape, same
 * key order, counts that describe what we return, and the FIRST response's
 * headers. The last call's headers would carry a rate-limit budget short by
 * exactly the number of pages we walked — which is a measure of how many
 * objects were hidden. The tradeoff is deliberate: the agent may see a budget
 * that is up to `MAX_REFILL_CALLS` ahead of the vendor's real one.
 */
export async function refill(
  deps: ForwardDeps,
  call: RefillCall,
  first: ForwardOutcome,
): Promise<ResponseShape> {
  const filter = call.filter;
  const rule = filter?.plan.pagination;
  if (filter === undefined || rule === undefined) return first;
  const page = readPage(first.body, rule, {
    removed: first.removed,
    at: undefined,
  });
  if (page === undefined) return first;
  if (page.nodes.length >= rule.requested || !page.hasNextPage) return first;

  const walk = await walkPages(
    deps,
    call,
    filter,
    page,
    first.status,
    rule.requested,
  );
  const kept = walk.nodes.slice(0, rule.requested);
  const body = mergedBody(
    page,
    rule,
    kept,
    mergedPageInfo(walk, page, kept.length),
  );
  // A body we cannot rebuild leaves the first page exactly as it was: short,
  // and already saying there is more.
  if (body === undefined) return first;
  return { status: first.status, headers: first.headers, body };
}
