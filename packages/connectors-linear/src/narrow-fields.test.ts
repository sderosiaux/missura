import { parse, print } from "graphql";
import { describe, expect, it } from "vitest";
import { narrowLinear, type LinearNarrowResult } from "./narrow";

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

/** Whitespace-insensitive comparison of a printed document. */
function normalized(query: string): string {
  return print(parse(query)).replace(/\s+/g, " ").trim();
}

describe("narrowLinear — issue(id) ownership post-check", () => {
  it("adds `customer { id }` and reports the injection", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { id title } }`),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(normalized(queryOf(result))).toContain("customer { id }");
    expect(result.postCheck).toEqual({
      path: ["data", "issue", "customer", "id"],
      expectedCustomerId: "c_18",
      injectedSelection: true,
    });
  });

  it("leaves the document alone when the agent already asked for customer.id", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { id customer { id } } }`),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(result.body).toBeUndefined();
    expect(result.postCheck).toEqual({
      path: ["data", "issue", "customer", "id"],
      expectedCustomerId: "c_18",
      injectedSelection: false,
    });
  });

  it("adds only `id` inside an existing customer selection — nothing to strip", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { customer { name } } }`),
      SCOPE,
    );
    expect(normalized(queryOf(result))).toContain("customer { name id }");
    expect(result.postCheck?.injectedSelection).toBe(false);
  });

  it("anchors the post-check path on the alias of the issue field", () => {
    const result = narrowLinear(
      request(`query { mine: issue(id: "i1") { id } }`),
      SCOPE,
    );
    expect(result.postCheck?.path).toEqual([
      "data",
      "mine",
      "customer",
      "id",
    ]);
  });

  it("denies a selection that aliases another field to the `customer` key", () => {
    const result = narrowLinear(
      request(`query { issue(id: "i1") { customer: assignee { id } } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("customer");
  });

  it("denies a fragment inside the issue selection — the check cannot be proven", () => {
    const result = narrowLinear(
      request(
        `query { issue(id: "i1") { ...F } } fragment F on Issue { id customer { id } }`,
      ),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("fragment");
  });

  it("denies two issue root fields — one post-check cannot cover both", () => {
    const result = narrowLinear(
      request(`query { a: issue(id: "i1") { id } b: issue(id: "i2") { id } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("issue");
  });
});

describe("narrowLinear — per-root-field scope policy", () => {
  it("allows the mission's own customer(id) untouched", () => {
    const result = narrowLinear(
      request(`query { customer(id: "c_18") { id name } }`),
      SCOPE,
    );
    expect(result).toEqual({ decision: "allow" });
  });

  it("resolves the customer id from a variable", () => {
    const query = `query C($id: String!) { customer(id: $id) { id } }`;
    expect(narrowLinear(request(query, { id: "c_18" }), SCOPE).decision).toBe(
      "allow",
    );
    const other = narrowLinear(request(query, { id: "c_globex" }), SCOPE);
    expect(other.decision).toBe("deny");
    expect(other.reason).toBe("out-of-scope customer");
  });

  it("denies customer(id) for any other customer", () => {
    const result = narrowLinear(
      request(`query { customer(id: "c_globex") { id } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("out-of-scope customer");
  });

  it("denies customer without a resolvable id", () => {
    const result = narrowLinear(request(`query { customer { id } }`), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("out-of-scope customer");
  });

  it("denies the customers list", () => {
    const result = narrowLinear(
      request(`query { customers { nodes { id } } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("customer(id)");
  });

  it("allows viewer untouched", () => {
    const result = narrowLinear(request(`query { viewer { id name } }`), SCOPE);
    expect(result).toEqual({ decision: "allow" });
  });

  it.each(["projects", "project", "comments", "comment"])(
    "denies %s — no proven relation to the mission customer",
    (field) => {
      const result = narrowLinear(request(`query { ${field} { id } }`), SCOPE);
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("no proven relation to mission customer");
    },
  );
});

describe("narrowLinear — mission without a linear customer", () => {
  it("allows viewer", () => {
    expect(narrowLinear(request(`query { viewer { id } }`), {})).toEqual({
      decision: "allow",
    });
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
    expect(query).toContain('customer: {id: {eq: "c_18"}}');
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

  it("narrows issues and post-checks issue in the same document", () => {
    const result = narrowLinear(
      request(`query { issues { nodes { id } } issue(id: "i1") { id } }`),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(normalized(queryOf(result))).toContain('customer: {id: {eq: "c_18"}}');
    expect(result.postCheck?.path).toEqual(["data", "issue", "customer", "id"]);
  });
});

describe("narrowLinear — fails closed on anything it cannot read", () => {
  it("denies a non-JSON body", () => {
    expect(narrowLinear("not json", SCOPE).decision).toBe("deny");
  });

  it("denies a payload without a string query", () => {
    expect(narrowLinear(JSON.stringify({ variables: {} }), SCOPE).decision).toBe(
      "deny",
    );
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
