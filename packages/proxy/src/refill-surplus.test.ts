import type { MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import { handle } from "./pipeline";
import { CLAIMS, harness, type Harness } from "./pipeline.fixtures";
import { MAX_REFILL_CALLS } from "./refill";
import {
  connection,
  cursorOf,
  graphqlRequest,
  idsOf,
  plan,
  positionOf,
  requestedPlan,
  serveWalk,
  withPlan,
  type PageSpec,
} from "./refill.fixtures";

/**
 * The surplus a walk collects past the page the agent asked for.
 *
 * The answer must stay exactly as long as the requested page — a longer one
 * would itself count the pages we walked — so the surplus cannot be appended to
 * it. It is carried into the NEXT page instead, which needs the handle to stand
 * for a position AND an offset into the page starting there.
 */

/** `i…` belongs to the mission, `x…` to another customer (`refill.fixtures`). */
const OVERSHOOT: readonly PageSpec[] = [
  { ids: ["i1", "x2"], endCursor: "c1", hasNextPage: true },
  { ids: ["i3", "i4"], endCursor: "c2", hasNextPage: true },
  { ids: ["i5"], endCursor: "c3", hasNextPage: false },
];

/** Four vendor pages against a page size of 3: every boundary falls mid-page. */
const RAGGED: readonly PageSpec[] = [
  { ids: ["i1", "x2", "x3"], endCursor: "c1", hasNextPage: true },
  { ids: ["i4", "i5", "i6"], endCursor: "c2", hasNextPage: true },
  { ids: ["x7", "i8", "i9"], endCursor: "c3", hasNextPage: true },
  { ids: ["i10", "x11"], endCursor: "c4", hasNextPage: false },
];

/** Every page the agent gets, in order, iterating the way an SDK would. */
async function drive(h: Harness, first: number): Promise<string[][]> {
  const pages: string[][] = [];
  let after: string | undefined;
  // A collection this small ends long before this; the bound is here so a
  // regression that never reports the end fails as a test rather than a hang.
  for (let step = 0; step < 12; step += 1) {
    const res = await handle(h.deps, graphqlRequest(first, after));
    pages.push(idsOf(res.body));
    if (!connection(res.body).pageInfo.hasNextPage) return pages;
    after = cursorOf(res.body);
  }
  throw new Error("the collection never reported its end");
}

describe("pagination refill — the surplus a walk overshoots", () => {
  it("serves the overshot objects on the next page instead of dropping them", async () => {
    const h = harness({ narrow: withPlan(plan(2)) }, serveWalk(OVERSHOOT));

    const one = await handle(h.deps, graphqlRequest(2));
    // `i4` came back on the same vendor page as `i3` and does not fit here.
    expect(idsOf(one.body)).toEqual(["i1", "i3"]);
    expect(connection(one.body).pageInfo.hasNextPage).toBe(true);

    const two = await handle(h.deps, graphqlRequest(2, cursorOf(one.body)));
    // It is the FIRST object of the next page: not skipped, not repeated.
    expect(idsOf(two.body)).toEqual(["i4", "i5"]);
  });

  it("serves every authorized object exactly once across the whole walk", async () => {
    const h = harness({ narrow: withPlan(plan(3)) }, serveWalk(RAGGED));

    const pages = await drive(h, 3);

    expect(pages).toEqual([["i1", "i4", "i5"], ["i6", "i8", "i9"], ["i10"]]);
    const served = pages.flat();
    expect(served).toEqual(["i1", "i4", "i5", "i6", "i8", "i9", "i10"]);
    expect(new Set(served).size).toBe(served.length);
  });

  it("never answers with more objects than the agent asked for", async () => {
    const h = harness({ narrow: withPlan(plan(3)) }, serveWalk(RAGGED));

    const pages = await drive(h, 3);

    // Including the resumed pages, which start inside a page of nine objects
    // the walk had already read.
    expect(pages.every((page) => page.length <= 3)).toBe(true);
  });

  /**
   * The offset is counted in AUTHORIZED objects from a position, not in vendor
   * page slots — so it survives the agent changing its page size between calls,
   * which re-cuts the vendor's pages under it. Nothing is lost or repeated.
   */
  it("keeps the offset meaningful when the agent shrinks its page size", async () => {
    const wide: readonly PageSpec[] = [
      { ids: ["i1", "x2", "x3"], endCursor: "c1", hasNextPage: true },
      { ids: ["i4", "i5", "i6", "i7"], endCursor: "c2", hasNextPage: true },
      { ids: ["i8"], endCursor: "c3", hasNextPage: false },
    ];
    const h = harness({ narrow: requestedPlan }, serveWalk(wide));

    const one = await handle(h.deps, graphqlRequest(3));
    expect(idsOf(one.body)).toEqual(["i1", "i4", "i5"]);

    const two = await handle(h.deps, graphqlRequest(1, cursorOf(one.body)));
    expect(idsOf(two.body)).toEqual(["i6"]);

    const three = await handle(h.deps, graphqlRequest(1, cursorOf(two.body)));
    expect(idsOf(three.body)).toEqual(["i7"]);
  });

  /**
   * A resumed request is one agent request and is bounded like one: the page it
   * resumes into is re-read at its own expense, and the walk past it stops at
   * the same cap a fresh request would.
   */
  it("walks on from a resumed page that is short, and stops at the cap", async () => {
    const barren: PageSpec[] = [
      { ids: ["i1", "x2", "x3"], endCursor: "c1", hasNextPage: true },
      { ids: ["i4", "i5", "i6"], endCursor: "c2", hasNextPage: true },
    ];
    for (let i = 2; i < 9; i += 1) {
      barren.push({
        ids: [`x${String(i)}`],
        endCursor: `c${String(i + 1)}`,
        hasNextPage: true,
      });
    }
    const h = harness({ narrow: withPlan(plan(3)) }, serveWalk(barren));

    const one = await handle(h.deps, graphqlRequest(3));
    expect(idsOf(one.body)).toEqual(["i1", "i4", "i5"]);
    const spent = h.fetchCount();

    const two = await handle(h.deps, graphqlRequest(3, cursorOf(one.body)));

    // One call for the page it resumes into, then the cap on top of it.
    expect(h.fetchCount() - spent).toBe(1 + MAX_REFILL_CALLS);
    expect(idsOf(two.body)).toEqual(["i6"]);
    expect(connection(two.body).pageInfo.hasNextPage).toBe(true);
  });

  it("hands back a handle that is not the boundary it looks like", async () => {
    const h = harness({ narrow: withPlan(plan(2)) }, serveWalk(OVERSHOOT));

    const one = await handle(h.deps, graphqlRequest(2));

    // On our side it is a position PLUS an offset: the page starting at `c1`,
    // one of whose authorized objects the agent already holds.
    expect(positionOf(h, one.body)).toEqual({ vendorCursor: "c1", served: 1 });
    // On the agent's side it is the same bytes as any other handle. The offset
    // is a count of objects hidden from it, and it never crosses the boundary.
    const boundary = await handle(
      h.deps,
      graphqlRequest(2, cursorOf(one.body)),
    );
    expect(positionOf(h, boundary.body)?.served).toBe(0);
    expect(cursorOf(one.body)).toHaveLength(cursorOf(boundary.body).length);
    expect(cursorOf(one.body)).not.toContain("c1");
  });

  it("refuses a surplus handle replayed under another mission", async () => {
    const h = harness({ narrow: withPlan(plan(2)) }, serveWalk(OVERSHOOT));
    const one = await handle(h.deps, graphqlRequest(2));

    const other: MissionClaims = { ...CLAIMS, id: "msn_other", jti: "jti-2" };
    const replay = harness(
      {
        narrow: withPlan(plan(2)),
        cursors: h.deps.cursors,
        verifyToken: (): MissionClaims => other,
      },
      serveWalk(OVERSHOOT),
    );
    const res = await handle(
      replay.deps,
      graphqlRequest(2, cursorOf(one.body)),
    );

    // Fail closed, and before the vendor is touched: an offset we cannot vouch
    // for would resume the agent inside a page nothing authorized.
    expect(res.status).toBe(403);
    expect(replay.fetchCount()).toBe(0);
    expect(replay.events[0]?.reason).toContain("cursor");
  });
});
