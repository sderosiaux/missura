import type { FilterRule } from "@missura/core";
import { parse, print } from "graphql";
import { describe, expect, it } from "vitest";
import { narrowLinear, type LinearNarrowResult } from "./narrow";

const SCOPE = { linearCustomerId: "c_18" };

/**
 * `@linear/sdk@90` declares no `Issue.customer`: the customer link is
 * `Issue.needs` → `CustomerNeed.customer`, a collection, so an issue can belong
 * to several customers and belongs to the mission when ANY need names it
 * (SPEC §4.4.3, decided permissive).
 */
const ISSUE_OWNER = ["needs", "nodes", "*", "customer", "id"];

function request(query: string, variables?: Record<string, unknown>): string {
  const payload: Record<string, unknown> = { query };
  if (variables !== undefined) payload.variables = variables;
  return JSON.stringify(payload);
}

function queryOf(result: LinearNarrowResult): string {
  const payload = JSON.parse(result.body ?? "") as Record<string, unknown>;
  return String(payload.query);
}

/** Whitespace-insensitive comparison of a printed document. */
function normalized(query: string): string {
  return print(parse(query)).replace(/\s+/g, " ").trim();
}

function rules(result: LinearNarrowResult): readonly FilterRule[] {
  return result.filterPlan?.rules ?? [];
}

function ruleAt(result: LinearNarrowResult, path: readonly string[]): FilterRule {
  const found = rules(result).find(
    (rule) => rule.path.join(".") === path.join("."),
  );
  expect(found, `no rule at ${path.join(".")}`).toBeDefined();
  if (found === undefined) throw new Error("unreachable");
  return found;
}

describe("narrowLinear — issue(id) becomes a filter rule", () => {
  it("adds the whole needs route and reports it as ours to strip", () => {
    const result = narrowLinear(request(`query { issue(id: "i1") { id title } }`), SCOPE);

    expect(result.decision).toBe("allow");
    expect(normalized(queryOf(result))).toContain(
      "needs { nodes { customer { id } } }",
    );
    expect(rules(result)).toEqual([
      {
        path: ["data", "issue"],
        type: "Issue",
        ownerPath: ISSUE_OWNER,
        expectedOwnerIds: ["c_18"],
        ownerMatch: "exact",
        injected: ["needs"],
        // `issue(id:)` is not a field we proved nullable, so a foreign one
        // cannot be nulled: the response fails closed instead.
        nullable: false,
      },
    ]);
    expect(result.filterPlan?.strip).toEqual([]);
  });

  it("leaves the document alone when the agent already asked for the route", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { id needs { nodes { customer { id } } } } }`),
      SCOPE,
    );

    expect(result.decision).toBe("allow");
    expect(result.body).toBeUndefined();
    expect(ruleAt(result, ["data", "issue"]).injected).toEqual([]);
  });

  it("strips only what it widened INSIDE a selection the agent asked for", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { needs { pageInfo { hasNextPage } } } }`),
      SCOPE,
    );

    expect(normalized(queryOf(result))).toContain(
      "needs { pageInfo { hasNextPage } nodes { customer { id } } }",
    );
    // The `needs` key is the agent's; the `nodes` inside it is ours, so it
    // leaves by absolute path rather than taking the whole relation with it.
    expect(ruleAt(result, ["data", "issue"]).injected).toEqual([]);
    expect(result.filterPlan?.strip).toEqual([["data", "issue", "needs", "nodes"]]);
  });

  it("emits a rule for the needs the agent selected, so foreign ones are removed", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { needs { nodes { content } } } }`),
      SCOPE,
    );

    // The issue is in scope because ONE need names the mission customer; the
    // needs of the other customers are customer-scoped objects of their own and
    // are dropped from the list, so the agent never learns who else is on it.
    const need = ruleAt(result, ["data", "issue", "needs", "nodes", "*"]);
    expect(need.type).toBe("CustomerNeed");
    expect(need.ownerPath).toEqual(["customer", "id"]);
    expect(need.injected).toEqual(["customer"]);
  });

  it("anchors the rule path on the alias of the issue field", () => {
    const result = narrowLinear(request(`query { mine: issue(id: "i1") { id } }`), SCOPE);

    expect(ruleAt(result, ["data", "mine"]).type).toBe("Issue");
  });

  it("denies a selection that aliases another field to a route key", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { needs: comments { nodes { id } } } }`),
      SCOPE,
    );

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("needs");
  });

  it("resolves a fragment inside the issue selection before proving ownership", () => {
    const result = narrowLinear(
      request(
        `query { issue(id: "i1") { ...F } } fragment F on Issue { id needs { nodes { customer { id } } } }`,
      ),
      SCOPE,
    );

    expect(result.decision).toBe("allow");
    // The fragment is inlined, so what NARROW validated is what the vendor runs.
    expect(normalized(queryOf(result))).toBe(
      `{ issue(id: "i1") { id needs { nodes { customer { id } } } } }`,
    );
    expect(ruleAt(result, ["data", "issue"]).injected).toEqual([]);
  });

  it("injects the ownership route into a fragment that lacks it", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { ...F } } fragment F on Issue { id title }`),
      SCOPE,
    );

    expect(result.decision).toBe("allow");
    expect(normalized(queryOf(result))).toContain("needs { nodes { customer { id } } }");
    expect(ruleAt(result, ["data", "issue"]).injected).toEqual(["needs"]);
  });

  it("covers two issue root fields with one rule each — a plan is not a single check", () => {
    const result = narrowLinear(
      request(`query { a: issue(id: "i1") { id } b: issue(id: "i2") { id } }`),
      SCOPE,
    );

    expect(result.decision).toBe("allow");
    expect(rules(result).map((rule) => rule.path)).toEqual([
      ["data", "a"],
      ["data", "b"],
    ]);
  });
});
