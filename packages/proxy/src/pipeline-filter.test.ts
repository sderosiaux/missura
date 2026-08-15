import type { FilterPlan } from "@missura/core";
import { describe, expect, it } from "vitest";
import type { NarrowResult } from "./narrow";
import { handle } from "./pipeline";
import { bodyText, harness, request } from "./pipeline.fixtures";

const PLAN: FilterPlan = {
  rules: [
    {
      path: ["data", "issues", "nodes", "*"],
      type: "Issue",
      ownerPath: ["customer", "id"],
      expectedOwnerIds: ["c_18"],
      ownerMatch: "exact",
      injected: ["customer"],
      nullable: false,
    },
  ],
  strip: [],
};

function graphql(body: unknown): () => Promise<Response> {
  return async (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

function withPlan(plan: FilterPlan): () => NarrowResult {
  return (): NarrowResult => ({ decision: "allow", filterPlan: plan });
}

const TWO_ISSUES = {
  data: {
    issues: {
      nodes: [
        { id: "i1", customer: { id: "c_18" } },
        { id: "i2", customer: { id: "c_globex" } },
      ],
      totalCount: 2,
    },
  },
};

describe("pipeline — response filter", () => {
  it("filters after the vendor answered and records what it removed", async () => {
    const h = harness({ narrow: withPlan(PLAN) }, graphql(TWO_ISSUES));
    const res = await handle(h.deps, request());

    expect(h.fetchCount()).toBe(1);
    expect(res.status).toBe(200);
    // The vendor's `totalCount` is gone rather than recomputed: whether a count
    // survives must be a fact about the plan, never about the number it held.
    expect(JSON.parse(bodyText(res.body))).toEqual({
      data: { issues: { nodes: [{ id: "i1" }] } },
    });
    expect(bodyText(res.body)).not.toContain("c_globex");
    expect(h.events[0]?.decision).toBe("allow");
    expect(h.events[0]?.objectsRemoved).toBe(1);
  });

  it("keeps the vendor content-type on a filtered response", async () => {
    const h = harness({ narrow: withPlan(PLAN) }, graphql(TWO_ISSUES));
    const res = await handle(h.deps, request());

    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("fails closed with `unfilterable` when a foreign object cannot be removed", async () => {
    const plan: FilterPlan = {
      rules: [
        {
          path: ["data", "issue"],
          type: "Issue",
          ownerPath: ["customer", "id"],
          expectedOwnerIds: ["c_18"],
          ownerMatch: "exact",
          injected: [],
          nullable: false,
        },
      ],
      strip: [],
    };
    const h = harness(
      { narrow: withPlan(plan) },
      graphql({ data: { issue: { id: "i1", customer: { id: "c_globex" } } } }),
    );
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual({
      errors: [{ message: "issue not found" }],
    });
    expect(bodyText(res.body)).not.toContain("c_globex");
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe("unfilterable");
  });

  it("fails closed on a non-JSON body under a filter plan", async () => {
    const h = harness({ narrow: withPlan(PLAN) });
    const res = await handle(h.deps, request());

    expect(bodyText(res.body)).toBe(
      '{"errors":[{"message":"issue not found"}]}',
    );
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe("unfilterable");
  });

  it("records no removal count when the connector registered no plan", async () => {
    const h = harness({}, graphql(TWO_ISSUES));
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual(TWO_ISSUES);
    expect(h.events[0]?.objectsRemoved).toBeUndefined();
  });

  it("records a zero removal count when the plan removed nothing", async () => {
    const h = harness(
      { narrow: withPlan(PLAN) },
      graphql({
        data: {
          issues: { nodes: [{ id: "i1", customer: { id: "c_18" } }] },
        },
      }),
    );
    await handle(h.deps, request());

    expect(h.events[0]?.objectsRemoved).toBe(0);
  });
});
