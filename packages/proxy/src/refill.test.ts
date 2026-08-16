import { describe, expect, it } from "vitest";
import { handle } from "./pipeline";
import { bodyText, harness } from "./pipeline.fixtures";
import { MAX_REFILL_CALLS, REFILL_BUDGET_MS } from "./refill";
import {
  behindCursor,
  connection,
  graphqlRequest,
  page,
  plan,
  sentBody,
  serveEach,
  withoutCursor,
  withoutHandle,
  withPlan,
} from "./refill.fixtures";

const PAGES: readonly unknown[] = [
  page(["i1", "x2", "x3"], true, "c1"),
  page(["x4", "i5", "i6"], true, "c2"),
];

describe("pagination refill", () => {
  it("caps the walk at 5 extra calls or 10 s", () => {
    expect(MAX_REFILL_CALLS).toBe(5);
    expect(REFILL_BUDGET_MS).toBe(10_000);
  });

  it("walks the next page until the requested count is reached", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach((i) => PAGES[i]),
    );
    const res = await handle(h.deps, graphqlRequest(3));

    expect(h.fetchCount()).toBe(2);
    expect(connection(res.body).nodes).toEqual([
      { id: "i1" },
      { id: "i5" },
      { id: "i6" },
    ]);
    expect(bodyText(res.body)).not.toContain("c_globex");
  });

  it("re-issues the request with the vendor cursor and nothing else changed", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach((i) => PAGES[i]),
    );
    await handle(h.deps, graphqlRequest(3));

    expect(h.calls[1]?.url).toBe("https://api.github.com/graphql");
    expect(sentBody(h.calls[1])).toEqual({
      query: "query Issues($first: Int!, $after: String) { issues { … } }",
      variables: { first: 3, after: "c1" },
    });
  });

  it("does not call the vendor twice when the first page is already full", async () => {
    const h = harness(
      { narrow: withPlan(plan(2)) },
      serveEach(() => page(["i1", "i2"], true, "c1")),
    );
    const res = await handle(h.deps, graphqlRequest(2));

    expect(h.fetchCount()).toBe(1);
    expect(connection(res.body).pageInfo.hasNextPage).toBe(true);
    // A handle of ours, not the vendor's position — even on a page we did not
    // walk, so the cursor's format never says whether a walk happened.
    expect(connection(res.body).pageInfo.endCursor).not.toBe("c1");
    expect(behindCursor(h, res.body)).toBe("c1");
  });

  it("stops at the call cap and stays honest about the rest", async () => {
    const h = harness(
      { narrow: withPlan(plan(10)) },
      serveEach((i) =>
        page([`i${String(i)}`, "x1", "x2"], true, `c${String(i)}`),
      ),
    );
    const res = await handle(h.deps, graphqlRequest(10));

    expect(h.fetchCount()).toBe(1 + MAX_REFILL_CALLS);
    const conn = connection(res.body);
    expect(conn.nodes).toHaveLength(1 + MAX_REFILL_CALLS);
    expect(conn.pageInfo.hasNextPage).toBe(true);
  });

  it("stops when the time budget is spent, before the call cap", async () => {
    let clock = 0;
    const h = harness(
      {
        narrow: withPlan(plan(10)),
        now: (): number => clock,
      },
      serveEach((i) => {
        clock += 4_000;
        return page([`i${String(i)}`, "x1"], true, `c${String(i)}`);
      }),
    );
    const res = await handle(h.deps, graphqlRequest(10));

    expect(h.fetchCount()).toBe(3);
    expect(connection(res.body).pageInfo.hasNextPage).toBe(true);
  });

  it("stops on the vendor's last page and reports the end", async () => {
    const h = harness(
      { narrow: withPlan(plan(5)) },
      serveEach((i) =>
        i === 0 ? page(["i1", "x2"], true, "c1") : page(["i3"], false, "c2"),
      ),
    );
    const res = await handle(h.deps, graphqlRequest(5));

    expect(h.fetchCount()).toBe(2);
    expect(connection(res.body).pageInfo.hasNextPage).toBe(false);
    expect(behindCursor(h, res.body)).toBe("c2");
  });

  it("returns the requested count and keeps the leftovers behind a cursor", async () => {
    const h = harness(
      { narrow: withPlan(plan(2)) },
      serveEach((i) =>
        i === 0
          ? page(["i1", "x2"], true, "c1")
          : page(["i3", "i4"], false, "c2"),
      ),
    );
    const res = await handle(h.deps, graphqlRequest(2));

    const conn = connection(res.body);
    expect(conn.nodes).toEqual([{ id: "i1" }, { id: "i3" }]);
    // The vendor said this was its last page; we still hold one authorized
    // object back, so the answer must not claim the collection is exhausted.
    expect(conn.pageInfo.hasNextPage).toBe(true);
  });

  it("never serves the vendor's own total across a refill", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach((i) =>
        i === 0
          ? page(["i1", "x2", "x3"], true, "c1", { totalCount: 412 })
          : page(["i4", "i5", "x6"], true, "c2", { totalCount: 412 }),
      ),
    );
    const res = await handle(h.deps, graphqlRequest(3));

    expect(connection(res.body).totalCount).toBeUndefined();
    // Past the handle: it is random, and one roll in a few hundred spells 412.
    expect(withoutHandle(res.body)).not.toContain("412");
    expect(connection(res.body).nodes).toHaveLength(3);
  });

  /**
   * The merge cannot bring a count back either: the filter removed it on every
   * page before the walk saw one, so a walked answer and an unwalked one show
   * the same fields whatever the vendor was counting.
   */
  it("shows the same fields across a refill whatever the total was", async () => {
    const build = (total: number): ReturnType<typeof harness> =>
      harness(
        { narrow: withPlan(plan(3)) },
        serveEach((i) =>
          i === 0
            ? page(["i1", "x2", "x3"], true, "c1", { totalCount: total })
            : page(["i4", "i5", "x6"], true, "c2", { totalCount: total }),
        ),
      );

    const one = await handle(build(3).deps, graphqlRequest(3));
    const two = await handle(build(9_412).deps, graphqlRequest(3));

    expect(withoutCursor(one.body)).toBe(withoutCursor(two.body));
  });

  /**
   * The reason a handle is a fix and not a trade: replacing the vendor cursor
   * hides the walk position WITHOUT costing pagination. The agent sends the
   * handle back, and the vendor sees the position it actually left off at — so
   * it neither repeats objects (which the first page's cursor would have
   * caused) nor stops iterating (which dropping the cursor would have caused).
   */
  it("resumes at the vendor position the handle stands for", async () => {
    const h = harness(
      { narrow: withPlan(plan(2)) },
      serveEach(() => page(["i1", "i2"], true, "c1")),
    );
    const first = await handle(h.deps, graphqlRequest(2));
    const cursor = connection(first.body).pageInfo.endCursor;

    await handle(h.deps, {
      ...graphqlRequest(2),
      body: JSON.stringify({
        query: "query Issues($first: Int!, $after: String) { issues { … } }",
        variables: { first: 2, after: cursor },
      }),
    });

    expect(sentBody(h.calls[1])).toEqual({
      query: "query Issues($first: Int!, $after: String) { issues { … } }",
      variables: { first: 2, after: "c1" },
    });
  });

  it("makes every extra call its own decision event", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach((i) => PAGES[i]),
    );
    await handle(h.deps, graphqlRequest(3));

    expect(h.events).toHaveLength(2);
    expect(h.events.every((ev) => ev.decision === "allow")).toBe(true);
    expect(h.events.map((ev) => ev.objectsRemoved)).toEqual([2, 1]);
  });
});
