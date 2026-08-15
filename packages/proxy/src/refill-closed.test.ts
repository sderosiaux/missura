import { describe, expect, it } from "vitest";
import { handle } from "./pipeline";
import { bodyText, harness } from "./pipeline.fixtures";
import {
  connection,
  graphqlRequest,
  page,
  plan,
  serveEach,
  withPlan,
} from "./refill.fixtures";

/**
 * Two properties, and they are the reason refill is allowed to exist:
 *   - a refill that goes wrong returns fewer objects, never an unfiltered one;
 *   - how many vendor pages we walked is not readable from the answer. The
 *     walk length is a measure of how many objects were hidden, so a response
 *     that betrays it hands back exactly what filtering removed.
 */

const BROKEN_PAGE = { data: { issues: { nodes: "not-a-list" } } };

describe("pagination refill — fail closed", () => {
  it("keeps what it has when a refill call cannot reach the vendor", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach((i) => (i === 0 ? page(["i1", "x2"], true, "c1") : undefined)),
    );
    const res = await handle(h.deps, graphqlRequest(3));

    expect(res.status).toBe(200);
    const conn = connection(res.body);
    expect(conn.nodes).toEqual([{ id: "i1" }]);
    expect(conn.pageInfo.hasNextPage).toBe(true);
  });

  it("keeps what it has when a refill page has a shape it cannot read", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach((i) =>
        i === 0 ? page(["i1", "x2"], true, "c1") : BROKEN_PAGE,
      ),
    );
    const res = await handle(h.deps, graphqlRequest(3));

    expect(h.fetchCount()).toBe(2);
    expect(connection(res.body).nodes).toEqual([{ id: "i1" }]);
    expect(connection(res.body).pageInfo.hasNextPage).toBe(true);
  });

  it("never lets an unfilterable refill page reach the agent", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach((i) =>
        i === 0
          ? page(["i1", "x2"], true, "c1")
          : {
              // Not a list where the plan promised one: the filter cannot
              // prove a single object of it ours, so it refuses the page.
              data: {
                issues: {
                  nodes: { id: "x9", customer: { id: "c_globex" } },
                  pageInfo: { hasNextPage: true, endCursor: "c2" },
                },
              },
            },
      ),
    );
    const res = await handle(h.deps, graphqlRequest(3));

    expect(bodyText(res.body)).not.toContain("x9");
    expect(connection(res.body).nodes).toEqual([{ id: "i1" }]);
    // The refused page is its own record: the audit shows the vendor was asked.
    expect(h.events.map((ev) => ev.decision)).toEqual(["allow", "deny"]);
  });

  it("does not walk when the request body carries no place for a cursor", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach(() => page(["i1", "x2"], true, "c1")),
    );
    const res = await handle(h.deps, {
      ...graphqlRequest(3),
      body: JSON.stringify({ query: "{ issues { … } }" }),
    });

    expect(h.fetchCount()).toBe(1);
    expect(connection(res.body).pageInfo.hasNextPage).toBe(true);
  });
});

describe("pagination refill — the walk is not observable", () => {
  const RATE = (i: number): Record<string, string> => ({
    "x-ratelimit-remaining": String(99 - i),
  });

  it("answers the same bytes as a vendor page that held those objects", async () => {
    const walked = harness(
      { narrow: withPlan(plan(3)) },
      serveEach(
        (i) =>
          i === 0
            ? page(["i1", "x2", "x3"], true, "c1")
            : page(["x4", "i5", "i6"], true, "c2"),
        RATE,
      ),
    );
    const direct = harness(
      { narrow: withPlan(plan(3)) },
      serveEach(() => page(["i1", "i5", "i6"], true, "c2"), RATE),
    );

    const one = await handle(walked.deps, graphqlRequest(3));
    const two = await handle(direct.deps, graphqlRequest(3));

    expect(walked.fetchCount()).toBe(2);
    expect(direct.fetchCount()).toBe(1);
    expect(bodyText(one.body)).toBe(bodyText(two.body));
    expect(one.headers).toEqual(two.headers);
  });

  it("relays the first page's rate-limit budget, not the last call's", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach(
        (i) =>
          i === 0
            ? page(["i1", "x2", "x3"], true, "c1")
            : page(["i4", "i5", "x6"], true, "c2"),
        RATE,
      ),
    );
    const res = await handle(h.deps, graphqlRequest(3));

    expect(h.fetchCount()).toBe(2);
    expect(res.headers["x-ratelimit-remaining"]).toBe("99");
  });
});
