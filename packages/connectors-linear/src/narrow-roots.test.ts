import { parse, print } from "graphql";
import { describe, expect, it } from "vitest";
import { narrowLinear, type LinearNarrowResult } from "./narrow";

/**
 * What each ROOT field means under a mission, and everything the narrowing
 * refuses to read at all. The walk below the roots is type-driven and lives in
 * `narrow-fields.test.ts`; this file is about the entry points and the shapes
 * that never get as far as a walk.
 */

const SCOPE = { linearCustomerId: "c_18" };

function request(query: string, variables?: Record<string, unknown>): string {
  const payload: Record<string, unknown> = { query };
  if (variables !== undefined) payload.variables = variables;
  return JSON.stringify(payload);
}

function queryOf(result: LinearNarrowResult): string {
  const payload = JSON.parse(result.body ?? "") as Record<string, unknown>;
  return String(payload.query);
}

function normalized(query: string): string {
  return print(parse(query)).replace(/\s+/g, " ").trim();
}

function rules(result: LinearNarrowResult): readonly unknown[] {
  return result.filterPlan?.rules ?? [];
}

describe("narrowLinear — per-root-field scope policy", () => {
  it("allows the mission's own customer(id) and still proves it on the way back", () => {
    const result = narrowLinear(request(`query { customer(id: "c_18") { id name } }`), SCOPE);

    expect(result.decision).toBe("allow");
    expect(result.body).toBeUndefined();
    expect(rules(result)).toEqual([
      {
        path: ["data", "customer"],
        type: "Customer",
        ownerPath: ["id"],
        expectedOwnerIds: ["c_18"],
        ownerMatch: "exact",
        injected: [],
        nullable: false,
      },
    ]);
  });

  it("adds the discriminator when the agent did not ask for the id", () => {
    const result = narrowLinear(request(`query { customer(id: "c_18") { name } }`), SCOPE);

    expect(normalized(queryOf(result))).toBe(`{ customer(id: "c_18") { name id } }`);
    expect(result.filterPlan?.rules[0]?.injected).toEqual(["id"]);
  });

  it("resolves the customer id from a variable", () => {
    const query = `query C($id: String!) { customer(id: $id) { id } }`;
    expect(narrowLinear(request(query, { id: "c_18" }), SCOPE).decision).toBe("allow");
    const other = narrowLinear(request(query, { id: "c_globex" }), SCOPE);
    expect(other.decision).toBe("deny");
    expect(other.reason).toBe("out-of-scope customer");
  });

  it("denies customer(id) for any other customer", () => {
    const result = narrowLinear(request(`query { customer(id: "c_globex") { id } }`), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("out-of-scope customer");
  });

  it("denies customer without a resolvable id", () => {
    const result = narrowLinear(request(`query { customer { id } }`), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("out-of-scope customer");
  });

  it("denies the customers list", () => {
    const result = narrowLinear(request(`query { customers { nodes { id } } }`), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("customer(id)");
  });

  it("allows viewer with nothing to filter", () => {
    const result = narrowLinear(request(`query { viewer { id name } }`), SCOPE);
    expect(result).toEqual({ decision: "allow", filterPlan: { rules: [], strip: [] } });
  });

  /**
   * The M2 rule was "viewer is scalars-only", a rule about a name. The rule now
   * is about TYPES: `User.teams` is a connection of workspace metadata and is
   * fine, `User.assignedIssues` is a collection of customer-scoped issues under
   * a metadata type and is refused — nulling cannot repair a list, and
   * following one re-expands to the whole workspace.
   */
  it("allows a metadata connection under viewer", () => {
    const result = narrowLinear(request(`query { viewer { id teams { nodes { id } } } }`), SCOPE);
    expect(result.decision).toBe("allow");
    expect(rules(result)).toEqual([]);
  });

  it.each(["assignedIssues", "createdIssues", "delegatedIssues"])(
    "denies viewer > %s by type, not by name",
    (field) => {
      const result = narrowLinear(
        request(`query { viewer { id ${field}(first: 250) { nodes { id } } } }`),
        SCOPE,
      );
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain(`User.${field}`);
    },
  );

  it.each(["projects", "project", "comments", "comment", "teams"])(
    "denies the root field %s — the Query root is not a walkable type",
    (field) => {
      const result = narrowLinear(request(`query { ${field} { id } }`), SCOPE);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain(field);
    },
  );
});

describe("narrowLinear — mission without a linear customer", () => {
  it("allows viewer scalars", () => {
    expect(narrowLinear(request(`query { viewer { id } }`), {})).toEqual({
      decision: "allow",
      filterPlan: { rules: [], strip: [] },
    });
  });

  it("denies viewer carrying a customer-scoped collection", () => {
    const result = narrowLinear(
      request(`query { viewer { assignedIssues { nodes { id } } } }`),
      {},
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("assignedIssues");
  });

  it.each(["issues { nodes { id } }", `issue(id: "i1") { id }`, "customers { nodes { id } }"])(
    "denies %s",
    (selection) => {
      const result = narrowLinear(request(`query { ${selection} }`), {});
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("linear not in mission scope");
    },
  );
});

describe("narrowLinear — multi-root documents", () => {
  it("handles issues and viewer together", () => {
    const result = narrowLinear(
      request(`query { issues { nodes { id } } viewer { id } }`),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    const query = normalized(queryOf(result));
    expect(query).toContain('needs: {some: {customer: {id: {eq: "c_18"}}}}');
    expect(query).toContain("viewer { id }");
  });

  it("denies the whole document when one root field must be denied", () => {
    const result = narrowLinear(
      request(`query { issues { nodes { id } } projects { id } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.body).toBeUndefined();
  });

  it("narrows issues and rules on issue in the same document", () => {
    const result = narrowLinear(
      request(`query { issues { nodes { id } } issue(id: "i1") { id } }`),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(normalized(queryOf(result))).toContain('needs: {some: {customer: {id: {eq: "c_18"}}}}');
    expect(result.filterPlan?.rules.map((rule) => rule.path)).toEqual([
      ["data", "issues", "nodes", "*"],
      ["data", "issue"],
    ]);
  });
});

describe("narrowLinear — fails closed on anything it cannot read", () => {
  it("denies a non-JSON body", () => {
    expect(narrowLinear("not json", SCOPE).decision).toBe("deny");
  });

  it("denies a payload without a string query", () => {
    expect(narrowLinear(JSON.stringify({ variables: {} }), SCOPE).decision).toBe("deny");
  });

  it("denies unparseable graphql without echoing the source", () => {
    const result = narrowLinear(request(`query { issues {`), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("unparseable graphql");
  });

  it("denies a mutation", () => {
    const result = narrowLinear(
      request(`mutation { issueCreate(input: {}) { success } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
  });

  it("denies a multi-operation document", () => {
    const result = narrowLinear(
      request(`query A { viewer { id } } query B { viewer { id } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
  });

  it("denies a root fragment spread", () => {
    const result = narrowLinear(
      request(`query { ...R } fragment R on Query { viewer { id } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
  });

  it("denies a root field outside the policy table", () => {
    const result = narrowLinear(request(`query { teams { id } }`), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("teams");
  });
});
