import { describe, expect, it } from "vitest";
import { decideLinear } from "./catalog";

function body(query: string, operationName?: string): string {
  return JSON.stringify(
    operationName === undefined ? { query } : { query, operationName },
  );
}

describe("linear graphql catalog", () => {
  it("allows a read query over allowlisted root fields", () => {
    const d = decideLinear(
      body(`query IssuesQuery { issues(first: 3) { nodes { id title } } }`),
    );
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("IssuesQuery");
    expect(d.action).toBe("read");
  });

  it("names the first root field when the operation is anonymous", () => {
    const d = decideLinear(body(`{ viewer { id } }`));
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("viewer");
  });

  it("resolves aliases to the real field name", () => {
    const d = decideLinear(body(`query { myIssues: issues { nodes { id } } }`));
    expect(d.decision).toBe("allow");
  });

  it("denies an alias that hides a non-allowlisted field", () => {
    const d = decideLinear(body(`query { issues: teams { nodes { id } } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("teams");
  });

  it("denies mutations naming the operation type", () => {
    const d = decideLinear(
      body(`mutation Create { issueCreate(input: {}) { success } }`),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("mutation");
  });

  it("denies subscriptions naming the operation type", () => {
    const d = decideLinear(body(`subscription S { issues { id } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("subscription");
  });

  it("denies a root field outside the allowlist, naming the field", () => {
    const d = decideLinear(body(`query { teams { nodes { id } } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("teams");
  });

  it("denies introspection", () => {
    const d = decideLinear(body(`query { __schema { types { name } } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("__schema");
  });

  it("denies a document holding two operations", () => {
    const d = decideLinear(
      body(`query A { viewer { id } } query B { issues { nodes { id } } }`),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("2 operations");
  });

  it("denies malformed graphql", () => {
    const d = decideLinear(body(`query { issues {`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("unparseable");
  });

  it("denies a named fragment spread at the root", () => {
    const d = decideLinear(
      body(`query { ...Roots } fragment Roots on Query { issues { nodes { id } } }`),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("fragment at root unsupported");
  });

  it("denies an inline fragment at the root", () => {
    const d = decideLinear(
      body(`query { ... on Query { issues { nodes { id } } } }`),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("fragment at root unsupported");
  });

  it("denies a body that is not JSON", () => {
    const d = decideLinear("not json at all");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("body is not JSON");
  });

  it("denies a JSON body without a string query field", () => {
    const d = decideLinear(JSON.stringify({ variables: {} }));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("query");
  });

  it("denies a document with no operation at all", () => {
    const d = decideLinear(body(`fragment F on Query { issues { nodes { id } } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("no operation");
  });

  it("denies a multi-operation document even when operationName picks an allowed one", () => {
    const d = decideLinear(
      body(
        `query A { viewer { id } } query B { teams { nodes { id } } }`,
        "A",
      ),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("2 operations");
  });

  it("never returns a decision without a reason", () => {
    const d = decideLinear(body(`query { projects { nodes { id } } }`));
    expect(d.reason.length).toBeGreaterThan(0);
  });
});
