import type { CursorPosition } from "@missura/core";
import type { ForwardDeps, ForwardOutcome } from "./forward";
import { mergedBody, readPage, type VendorPage } from "./refill-page";
import { walkPages, type RefillCall, type Walk } from "./refill-walk";
import type { ResponseShape } from "./transport";

export {
  MAX_REFILL_CALLS,
  REFILL_BUDGET_MS,
  type RefillCall,
  type RefillResume,
} from "./refill-walk";

/**
 * Pagination REFILL: the other half of the response FILTER.
 *
 * Filtering a page of 50 down to 12 breaks two things at once. The SDK's
 * pagination helpers stop working — they asked for 50 and got 12 with a cursor
 * that no longer means what it says — and the short page itself announces that
 * 38 objects were hidden. So when the filter leaves a page short and the vendor
 * says there is more, we walk forward (`refill-walk.ts`, bounded) and merge
 * until the agent's page is as full as its authorized objects allow.
 *
 * The cursor the agent gets back is OURS (SPEC §22, `core/cursor.ts`): an
 * opaque handle standing for the vendor position, which never leaves the proxy.
 * That is what makes the walk unobservable — the last upstream cursor we used
 * says how far we went, and the walk length is a measure of how many objects
 * were hidden. It also makes a cursor replayed under a different mission fail
 * closed instead of resuming a walk that mission never made.
 *
 * A walk that collects MORE than the agent asked for keeps the surplus rather
 * than dropping it. It cannot be appended to this answer — an answer longer
 * than the page that was requested is itself a count of how many pages we
 * walked — so it is carried into the NEXT one: the handle we hand back stands
 * for where the page holding the surplus starts AND how many of its authorized
 * objects the agent has now been served. The next request re-fetches that
 * position, filters it exactly as before, drops that many off the front, and
 * walks on from there.
 *
 * REMAINING COST, and it is availability, not confidentiality: page-NUMBERED
 * pagination still drops its surplus. A `query-page` cursor is the agent's own
 * page number — it never became a handle of ours, so there is nothing in the
 * answer that could carry an offset back.
 */

/** The answer, plus what the position inside it still owes. */
export interface RefillOutcome extends ResponseShape {
  /**
   * Authorized objects already served from the page the answer's own position
   * starts. Zero for a plain page boundary; positive when this answer left a
   * surplus behind inside that page.
   */
  served: number;
}

/**
 * Where the objects this answer had no room for start, or `undefined` when it
 * had room for everything.
 *
 * The walk stops the moment it has enough, so a surplus can only ever sit in
 * the LAST page it read. The position to hand back is therefore where THAT page
 * starts, paired with how many of its authorized objects the agent has now been
 * served: re-fetching it and dropping that many off the front lands exactly on
 * the first object that did not fit.
 *
 * The count is in AUTHORIZED objects — after the filter, not raw vendor ones.
 * That is sound because the filter is a pure function of the mission's plan and
 * the page: reading the same position again under the same mission removes the
 * same objects, so the same prefix is the same prefix.
 *
 * `undefined` where the tail page has no position naming it: a `query-page`
 * walk, whose cursors are the agent's own page numbers and never became handles
 * of ours. There is nowhere to carry an offset, so the surplus is lost — the
 * one case the header's REMAINING COST still names.
 */
function surplusAt(
  walk: Walk,
  skip: number,
  requested: number,
): CursorPosition | undefined {
  const end = skip + requested;
  if (walk.nodes.length <= end || walk.tail.at === undefined) return undefined;
  return { vendorCursor: walk.tail.at, served: end - walk.tail.before };
}

/**
 * The page info WE answer with: the first page's, because that is where our
 * result set starts, carrying the only two fields the walk changes.
 *
 * `hasNextPage` is true unless the vendor ran out AND we are handing back
 * everything we collected. Every uncertain case resolves to true — a cap, an
 * error, an unreadable page — because "there may be more" costs the agent one
 * extra call, while a wrong `false` silently ends its iteration early.
 *
 * The cursor is the SURPLUS position when there is one, which points at a page
 * we have already partly served rather than at the boundary past it. The agent
 * cannot tell: it is swapped for a handle before the answer leaves, and a
 * handle is the same bytes whichever of the two it stands for.
 */
function mergedPageInfo(
  walk: Walk,
  first: VendorPage,
  taken: number,
  surplus: CursorPosition | undefined,
): Record<string, unknown> {
  const hasNextPage =
    walk.stopped || !walk.exhausted || taken < walk.nodes.length;
  const last = walk.last.next;
  const endCursor =
    surplus?.vendorCursor ??
    (last?.source === "body-path" ? last.cursor : undefined);
  return {
    ...first.pageInfo,
    hasNextPage,
    ...(endCursor === undefined ? {} : { endCursor }),
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
 *
 * The answer is exactly `requested` objects long whatever the walk cost, which
 * is the same property stated about its LENGTH: a page that grew with the walk
 * would count it just as plainly as a cursor that did.
 */
export async function refill(
  deps: ForwardDeps,
  call: RefillCall,
  first: ForwardOutcome,
): Promise<RefillOutcome> {
  // A body we cannot rebuild leaves the first page exactly as it was: short,
  // and already saying there is more. On a RESUMED request that also means
  // objects the agent already has come back a second time — a repeat, which
  // costs it a duplicate rather than a gap, and never shows it anything new.
  const untouched: RefillOutcome = {
    status: first.status,
    headers: first.headers,
    body: first.body,
    served: 0,
  };
  const filter = call.filter;
  const rule = filter?.plan.pagination;
  if (filter === undefined || rule === undefined) return untouched;
  const page = readPage(first.body, rule, {
    removed: first.removed,
    at: undefined,
  });
  if (page === undefined) return untouched;
  const skip = call.resume?.served ?? 0;
  // Untouched is only available when nothing is owed. A request resuming INTO a
  // page always rebuilds: the objects it already holds have to come off the
  // front, and a page that looks full still owes `skip` of them.
  if (skip === 0 && (page.nodes.length >= rule.requested || !page.hasNextPage))
    return untouched;

  const walk = await walkPages(
    deps,
    call,
    filter,
    page,
    first.status,
    rule.requested,
    skip,
  );
  const kept = walk.nodes.slice(skip, skip + rule.requested);
  const surplus = surplusAt(walk, skip, rule.requested);
  const body = mergedBody(
    page,
    rule,
    kept,
    mergedPageInfo(walk, page, skip + kept.length, surplus),
  );
  if (body === undefined) return untouched;
  return {
    status: first.status,
    headers: first.headers,
    body,
    served: surplus?.served ?? 0,
  };
}
