import type { FilterPlan } from "@missura/core";
import { describe, expect, it } from "vitest";
import { handle } from "./pipeline";
import { bodyText, harness, request } from "./pipeline.fixtures";
import {
  connection,
  graphqlRequest,
  page,
  plan,
  serveEach,
  withPlan,
} from "./refill.fixtures";

/**
 * A reduced view is FLAGGED, never MEASURED (§7quinquies.4). When the FILTER
 * removed objects or the REFILL walked pages, the agent is told the view was
 * reduced by policy — one boolean for the whole response — and never by how
 * much: not the objects removed, not the pages walked, not a total. An agent
 * that is not told becomes confidently wrong ("there are no issues for this
 * customer"); an agent that is told a number has been handed the count the
 * filter exists to hide.
 *
 * Absence is meaningful too: a response with nothing removed and no walk
 * carries NO marker at all, so `reduced: false` is never written.
 */

const RULES: FilterPlan["rules"] = [
  {
    path: ["data", "issues", "nodes", "*"],
    type: "Issue",
    ownerPath: ["customer", "id"],
    expectedOwnerIds: ["c_18"],
    ownerMatch: "exact",
    injected: ["customer"],
    nullable: false,
  },
];
const PLAN: FilterPlan = { rules: RULES, strip: [] };

const MIXED = {
  data: {
    issues: {
      nodes: [
        { id: "i1", customer: { id: "c_18" } },
        { id: "i2", customer: { id: "c_globex" } },
        { id: "i3", customer: { id: "c_globex" } },
      ],
      totalCount: 3,
    },
  },
};

const CLEAN = {
  data: { issues: { nodes: [{ id: "i1", customer: { id: "c_18" } }] } },
};

function json(body: unknown): () => Promise<Response> {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

/** Every key at every depth, so "no count anywhere" is checkable by name. */
function deepKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => deepKeys(item, `${prefix}[]`));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    `${prefix}${key}`,
    ...deepKeys(inner, `${prefix}${key}.`),
  ]);
}

const COUNT_WORDS = /removed|walked|total|count|hidden|pages|calls/i;

describe("reduced view — GraphQL carries the marker in `extensions`", () => {
  it("flags a filtered response, and says nothing about how much was removed", async () => {
    const h = harness(
      { provider: "linear", narrow: withPlan(PLAN) },
      json(MIXED),
    );
    const res = await handle(h.deps, request());

    expect(res.status).toBe(200);
    const body = JSON.parse(bodyText(res.body)) as Record<string, unknown>;
    // The whole body, pinned: the marker is the only thing added.
    expect(body).toEqual({
      data: { issues: { nodes: [{ id: "i1" }] } },
      extensions: { missura: { reduced: true } },
    });
    for (const key of deepKeys(body)) expect(key).not.toMatch(COUNT_WORDS);
    for (const name of Object.keys(res.headers)) {
      expect(name).not.toMatch(COUNT_WORDS);
      expect(name).not.toBe("missura-reduced");
    }
  });

  it("carries no marker at all when the plan removed nothing", async () => {
    const h = harness(
      { provider: "linear", narrow: withPlan(PLAN) },
      json(CLEAN),
    );
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual({
      data: { issues: { nodes: [{ id: "i1" }] } },
    });
    expect(bodyText(res.body)).not.toContain("reduced");
    expect(res.headers["missura-reduced"]).toBeUndefined();
  });

  it("carries no marker when no plan ran", async () => {
    const h = harness({ provider: "linear" }, json(CLEAN));
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual(CLEAN);
    expect(res.headers["missura-reduced"]).toBeUndefined();
  });

  it("flags a refilled page — the walk is the reduction", async () => {
    const h = harness(
      { provider: "linear", narrow: withPlan(plan(3)) },
      serveEach((i) =>
        i === 0
          ? page(["i1", "x2", "x3"], true, "c1")
          : page(["i4", "i5", "i6"], true, "c2"),
      ),
    );
    const res = await handle(h.deps, graphqlRequest(3));

    expect(h.fetchCount()).toBe(2);
    expect(connection(res.body).nodes).toEqual([
      { id: "i1" },
      { id: "i4" },
      { id: "i5" },
    ]);
    const body = JSON.parse(bodyText(res.body)) as Record<string, unknown>;
    expect(body.extensions).toEqual({ missura: { reduced: true } });
    for (const key of deepKeys(body)) expect(key).not.toMatch(COUNT_WORDS);
  });

  it("carries no marker on a full first page that needed no walk", async () => {
    const h = harness(
      { provider: "linear", narrow: withPlan(plan(2)) },
      serveEach(() => page(["i1", "i2"], true, "c1")),
    );
    const res = await handle(h.deps, graphqlRequest(2));

    expect(h.fetchCount()).toBe(1);
    expect(bodyText(res.body)).not.toContain("reduced");
  });

  it("keeps the vendor's own extensions beside the marker", async () => {
    const h = harness(
      { provider: "linear", narrow: withPlan(PLAN) },
      json({ ...MIXED, extensions: { requestId: "r1" } }),
    );
    const res = await handle(h.deps, request());

    expect((JSON.parse(bodyText(res.body)) as { extensions: unknown }).extensions)
      .toEqual({ requestId: "r1", missura: { reduced: true } });
  });
});

describe("reduced view — REST carries the marker in a header", () => {
  it("flags a filtered response with `missura-reduced: true` and nothing else", async () => {
    const h = harness({ narrow: withPlan(PLAN) }, json(MIXED));
    const res = await handle(h.deps, request());

    expect(res.status).toBe(200);
    expect(res.headers["missura-reduced"]).toBe("true");
    expect(JSON.parse(bodyText(res.body))).toEqual({
      data: { issues: { nodes: [{ id: "i1" }] } },
    });
    for (const [name, value] of Object.entries(res.headers)) {
      expect(name).not.toMatch(COUNT_WORDS);
      if (name !== "content-type") expect(value).toBe("true");
    }
    for (const key of deepKeys(JSON.parse(bodyText(res.body)))) {
      expect(key).not.toMatch(COUNT_WORDS);
    }
  });

  it("carries no header when the plan removed nothing", async () => {
    const h = harness({ narrow: withPlan(PLAN) }, json(CLEAN));
    const res = await handle(h.deps, request());

    expect(Object.keys(res.headers)).toEqual(["content-type"]);
  });

  it("carries no header when no plan ran", async () => {
    const h = harness({}, json(MIXED));
    const res = await handle(h.deps, request());

    expect(Object.keys(res.headers)).toEqual(["content-type"]);
  });
});
