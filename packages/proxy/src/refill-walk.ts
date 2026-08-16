import type { CatalogDecision, MissionClaims } from "@missura/core";
import type { RequestContext } from "./audit";
import type { FilterTask } from "./filter";
import { forward, upstreamTarget, type ForwardDeps } from "./forward";
import { readPage, withNext, type VendorPage } from "./refill-page";
import type { IncomingShape } from "./transport";

/**
 * The walk half of the REFILL: collecting authorized objects forward from a
 * position until there are enough of them. It decides nothing about what the
 * agent is answered — `refill.ts` cuts the answer out of what this returns.
 *
 * The walk is BOUNDED, because it multiplies the vendor load one agent request
 * can cause: at most `MAX_REFILL_CALLS` extra calls, and never past
 * `REFILL_BUDGET_MS` of total request time. Each extra call goes back through
 * `forward`, so the credential injection, the header allowlist, the response
 * cap, the filter and the audit record all stay in one place — and the audit
 * shows the real number of vendor calls a mission spent.
 */

/** Extra upstream calls one agent request may cause. */
export const MAX_REFILL_CALLS = 5;
/**
 * Wall-clock budget for the whole request, measured from the moment the proxy
 * received it — the deadline the agent actually experiences, so a slow first
 * page spends the budget it really spent.
 */
export const REFILL_BUDGET_MS = 10_000;

/** Where a resumed request picks a walk up, from a handle we issued. */
export interface RefillResume {
  /** The vendor position the request now carries, as a value. */
  at: string;
  /** Authorized objects already served, counted from `at`. */
  served: number;
}

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
  /** Absent for a request that carried no handle: the walk starts at zero. */
  resume?: RefillResume;
}

export interface Walk {
  /**
   * Authorized objects in vendor order, counted from the position the request
   * resumed at — INCLUDING the ones already served, which come off at the end.
   * Keeping them makes every index in this list mean the same thing whatever
   * page size the agent asked for.
   */
  nodes: unknown[];
  last: VendorPage;
  /**
   * The page the end of `nodes` came from: where it STARTS — the position that
   * fetched it, absent when nothing names one — and how many of `nodes` precede
   * it. Together they turn an index in `nodes` into an offset into that page.
   */
  tail: { at: string | undefined; before: number };
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
 *
 * `skip` is what the agent already holds, and the walk has to collect PAST it
 * before it has a full page — so a resumed request re-reads the page it was
 * left inside and is charged for it. The caps are the same either way: they
 * bound what one agent request may cost the vendor, and a resumed request is
 * one agent request.
 */
export async function walkPages(
  deps: ForwardDeps,
  call: RefillCall,
  filter: FilterTask,
  first: VendorPage,
  status: number,
  requested: number,
  skip: number,
): Promise<Walk> {
  const rule = filter.plan.pagination;
  const walk: Walk = {
    nodes: [...first.nodes],
    last: first,
    tail: { at: call.resume?.at, before: 0 },
    exhausted: false,
    stopped: false,
  };
  if (rule === undefined) return walk;
  for (let calls = 0; walk.nodes.length - skip < requested; calls += 1) {
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
    walk.tail = {
      at: after.source === "body-path" ? after.cursor : undefined,
      before: walk.nodes.length,
    };
    walk.nodes.push(...page.nodes);
    walk.last = page;
    if (!page.hasNextPage) return { ...walk, exhausted: true };
  }
  return walk;
}
