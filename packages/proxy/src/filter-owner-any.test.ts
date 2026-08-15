import type { FilterPlan, FilterRule } from "@missura/core";
import { describe, expect, it } from "vitest";
import { applyFilterPlan } from "./filter";

/**
 * Ownership through a COLLECTION, which is the shape Linear forces: an issue
 * carries no `customer` field at all — the link is `Issue.needs` →
 * `CustomerNeed.customer`, so an issue can belong to several customers at once.
 * A `"*"` in `ownerPath` says "any element of the array here", and the object
 * is ours when AT LEAST ONE of them resolves to a mission owner.
 *
 * The permissive reading is a product decision recorded in SPEC §4.4.3, not a
 * convenience: the needs of OTHER customers are themselves customer-scoped
 * objects and are removed by their own rule, so the issue passes while the
 * agent never learns who else is on it.
 */
const ISSUES: FilterRule = {
  path: ["data", "issues", "nodes", "*"],
  type: "Issue",
  ownerPath: ["needs", "nodes", "*", "customer", "id"],
  expectedOwnerIds: ["c_18"],
  ownerMatch: "exact",
  injected: [],
  nullable: false,
};

function plan(rules: readonly FilterRule[]): FilterPlan {
  return { rules, strip: [] };
}

/** One issue per argument; each argument lists the customers its needs name. */
function issues(...owners: (readonly string[])[]): string {
  return JSON.stringify({
    data: {
      issues: {
        nodes: owners.map((customers, index) => ({
          id: `i${String(index)}`,
          needs: {
            nodes: customers.map((id) => ({ customer: { id } })),
          },
        })),
      },
    },
  });
}

function keptIds(body: string): unknown {
  const parsed = JSON.parse(body) as {
    data: { issues: { nodes: { id: string }[] } };
  };
  return parsed.data.issues.nodes.map((node) => node.id);
}

describe("filter engine — ownership through a collection", () => {
  it("keeps an object when ANY element of the collection is ours", () => {
    const out = applyFilterPlan(
      plan([ISSUES]),
      issues(["c_18"], ["c_globex"], ["c_globex", "c_18"]),
    );

    expect(out.ok).toBe(true);
    expect(keptIds(out.body)).toEqual(["i0", "i2"]);
    expect(out.objectsRemoved).toBe(1);
  });

  it("drops an object whose collection is empty — nothing proves it ours", () => {
    const out = applyFilterPlan(plan([ISSUES]), issues([]));

    expect(keptIds(out.body)).toEqual([]);
  });

  it("drops an object whose collection is missing", () => {
    const body = JSON.stringify({
      data: { issues: { nodes: [{ id: "i0" }] } },
    });
    const out = applyFilterPlan(plan([ISSUES]), body);

    expect(keptIds(out.body)).toEqual([]);
  });

  it("drops an object whose collection is not an array", () => {
    const body = JSON.stringify({
      data: {
        issues: { nodes: [{ id: "i0", needs: { nodes: { customer: { id: "c_18" } } } }] },
      },
    });
    const out = applyFilterPlan(plan([ISSUES]), body);

    expect(keptIds(out.body)).toEqual([]);
  });

  it("ignores elements whose own owner leaf does not resolve", () => {
    const body = JSON.stringify({
      data: {
        issues: {
          nodes: [
            {
              id: "i0",
              needs: {
                nodes: [{ customer: null }, { customer: { id: "" } }, { customer: { id: "c_18" } }],
              },
            },
          ],
        },
      },
    });
    const out = applyFilterPlan(plan([ISSUES]), body);

    expect(keptIds(out.body)).toEqual(["i0"]);
  });

  it("nulls a foreign single object proven through a collection", () => {
    const rule: FilterRule = { ...ISSUES, path: ["data", "issue"], nullable: true };
    const body = JSON.stringify({
      data: { issue: { id: "i9", needs: { nodes: [{ customer: { id: "c_globex" } }] } } },
    });
    const out = applyFilterPlan(plan([rule]), body);

    expect(JSON.parse(out.body)).toEqual({ data: { issue: null } });
  });

  it("folds nothing a single-leaf owner path would not have folded", () => {
    // A `"*"` at the very end names the elements themselves, and an element is
    // an object, never a non-empty string: nothing resolves, so nothing is ours.
    const out = applyFilterPlan(
      plan([{ ...ISSUES, ownerPath: ["needs", "nodes", "*"] }]),
      issues(["c_18"]),
    );

    expect(keptIds(out.body)).toEqual([]);
  });
});
