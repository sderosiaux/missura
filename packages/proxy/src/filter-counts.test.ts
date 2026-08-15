import { describe, expect, it } from "vitest";
import { applyFilterPlan } from "./filter";
import { ISSUES, list, node, parse, plan } from "./filter.fixtures";

/**
 * The numbers that sit NEXT to a filtered list, and the flag that claims the
 * list is complete. Both describe a result set we changed, so both are the
 * proxy's problem — and the property under test is not "the number is right",
 * it is "what the agent can observe here is a function of the PLAN, never of
 * the vendor's hidden total".
 */

const MIXED = [node("i1", { id: "c_18" }), node("i2", { id: "c_globex" })];

function keysOf(body: string): string[] {
  const parsed = parse(body) as {
    data: { issues: Record<string, unknown> };
  };
  return Object.keys(parsed.data.issues).sort();
}

describe("filter engine — counts adjacent to a filtered list", () => {
  it("removes a count that described this page", () => {
    const out = applyFilterPlan(plan([ISSUES]), list(MIXED, { totalCount: 2 }));

    expect(parse(out.body)).toEqual({
      data: { issues: { nodes: [{ id: "i1" }] } },
    });
  });

  it("removes a total it could not have recomputed", () => {
    const out = applyFilterPlan(
      plan([ISSUES]),
      list(MIXED, { totalCount: 137, pageInfo: { hasNextPage: true } }),
    );

    expect(out.body).not.toContain("137");
    expect(parse(out.body)).toEqual({
      data: {
        issues: { nodes: [{ id: "i1" }], pageInfo: { hasNextPage: true } },
      },
    });
  });

  it("removes every count spelling next to the list", () => {
    const out = applyFilterPlan(
      plan([ISSUES]),
      list([node("i1", { id: "c_18" })], {
        totalCount: 900,
        total_count: 900,
        count: 900,
        total: 900,
      }),
    );

    expect(out.body).not.toContain("900");
    expect(keysOf(out.body)).toEqual(["nodes"]);
  });

  /**
   * The oracle this rule exists to close. A count that survives when it equals
   * the page and disappears otherwise makes its own PRESENCE a function of the
   * vendor's hidden total: ask for a page size, watch whether the field is
   * there, binary-search the size, and the global number falls out — with zero
   * authorized objects returned either way.
   */
  it("shows the same fields whatever the vendor's total was", () => {
    const small = applyFilterPlan(
      plan([ISSUES]),
      list(MIXED, {
        totalCount: 2,
      }),
    );
    const huge = applyFilterPlan(
      plan([ISSUES]),
      list(MIXED, {
        totalCount: 4_210,
      }),
    );

    expect(keysOf(small.body)).toEqual(keysOf(huge.body));
  });

  it("removes a count even when every object survived", () => {
    const out = applyFilterPlan(
      plan([{ ...ISSUES, injected: [] }]),
      list([node("i1", { id: "c_18" })], { totalCount: 1 }),
    );

    expect(keysOf(out.body)).toEqual(["nodes"]);
  });
});

describe("filter engine — completeness next to a filtered list", () => {
  it("stops claiming the page is complete once a plan applied to it", () => {
    const out = applyFilterPlan(
      plan([ISSUES]),
      list(MIXED, { incomplete_results: false }),
    );

    expect(parse(out.body)).toEqual({
      data: { issues: { nodes: [{ id: "i1" }], incomplete_results: true } },
    });
  });

  /**
   * Same reason as the counts: a flag that flips only when something WAS
   * removed answers "did this page hold objects I may not see" one page at a
   * time. It is set by the plan applying, not by what the plan found.
   */
  it("sets it the same way whether or not the plan found anything to remove", () => {
    const clean = applyFilterPlan(
      plan([ISSUES]),
      list([node("i1", { id: "c_18" })], { incomplete_results: false }),
    );

    expect(parse(clean.body)).toEqual({
      data: { issues: { nodes: [{ id: "i1" }], incomplete_results: true } },
    });
  });

  it("does not invent the flag on a vendor that never sends it", () => {
    const out = applyFilterPlan(plan([ISSUES]), list(MIXED));

    expect(keysOf(out.body)).toEqual(["nodes"]);
  });
});
