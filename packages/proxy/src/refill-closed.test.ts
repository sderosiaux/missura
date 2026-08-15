import { describe, expect, it } from "vitest";
import { handle } from "./pipeline";
import { bodyText, harness } from "./pipeline.fixtures";
import {
  behindCursor,
  connection,
  graphqlRequest,
  page,
  plan,
  serveEach,
  withoutCursor,
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

  /**
   * The control is a vendor whose FIRST page happened to hold exactly these
   * objects, so it carries the FIRST page's cursor. Building it with the walked
   * cursor — as this spec used to — made the assertion unfalsifiable: it
   * compared the walk against itself.
   */
  function walkedAndDirect(): {
    walked: ReturnType<typeof harness>;
    direct: ReturnType<typeof harness>;
  } {
    return {
      walked: harness(
        { narrow: withPlan(plan(3)) },
        serveEach(
          (i) =>
            i === 0
              ? page(["i1", "x2", "x3"], true, "c1")
              : page(["x4", "i5", "i6"], true, "c2"),
          RATE,
        ),
      ),
      direct: harness(
        { narrow: withPlan(plan(3)) },
        serveEach(() => page(["i1", "i5", "i6"], true, "c1"), RATE),
      ),
    };
  }

  it("answers the same bytes as a vendor page that held those objects, apart from the cursor", async () => {
    const { walked, direct } = walkedAndDirect();

    const one = await handle(walked.deps, graphqlRequest(3));
    const two = await handle(direct.deps, graphqlRequest(3));

    expect(walked.fetchCount()).toBe(2);
    expect(direct.fetchCount()).toBe(1);
    expect(withoutCursor(one.body)).toBe(withoutCursor(two.body));
    expect(one.headers).toEqual(two.headers);
  });

  /**
   * The cursor used to be the one field that betrayed the walk: we handed back
   * the LAST upstream cursor we used, so a walked answer carried `c2` where an
   * unwalked one carried `c1`. A Relay cursor is a vendor POSITION, and the
   * common `arrayconnection:N` spelling is plain base64, so decoding it gave
   * `position_walked − page_size` = objects hidden.
   *
   * It is now a missura handle (SPEC §22): same shape and same size whatever
   * position it stands for, and the vendor cursor stays on our side.
   */
  it("hands back a cursor that does not say how far it walked", async () => {
    const { walked, direct } = walkedAndDirect();

    const one = await handle(walked.deps, graphqlRequest(3));
    const two = await handle(direct.deps, graphqlRequest(3));

    const walkedCursor = connection(one.body).pageInfo.endCursor;
    const directCursor = connection(two.body).pageInfo.endCursor;
    expect(walkedCursor).not.toBe("c2");
    expect(directCursor).not.toBe("c1");
    // Indistinguishable: an agent holding both learns nothing from either.
    expect(walkedCursor).toHaveLength(directCursor.length);
    // …and each still resolves, on our side, to the position it stands for.
    expect(behindCursor(walked, one.body)).toBe("c2");
    expect(behindCursor(direct, two.body)).toBe("c1");
  });

  it("refuses a cursor this mission was never handed", async () => {
    const h = harness(
      { narrow: withPlan(plan(3)) },
      serveEach(() => page(["i1"], true, "c1")),
    );
    const res = await handle(h.deps, {
      ...graphqlRequest(3),
      body: JSON.stringify({
        query: "query Issues($first: Int!, $after: String) { issues { … } }",
        variables: { first: 3, after: "arrayconnection:4711" },
      }),
    });

    expect(h.fetchCount()).toBe(0);
    expect(res.status).toBe(403);
    expect(h.events[0]?.reason).toContain("cursor");
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
