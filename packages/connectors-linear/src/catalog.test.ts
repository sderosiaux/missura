import type { CatalogDecision } from "@missura/core";
import { describe, expect, it } from "vitest";
import { decideLinear } from "./catalog";

function body(query: string, operationName?: string): string {
  return JSON.stringify(
    operationName === undefined ? { query } : { query, operationName },
  );
}

/** The transport gate is asserted separately; body specs go through POST /graphql. */
function decide(payload: string): CatalogDecision {
  return decideLinear("POST", "/graphql", payload);
}

describe("linear transport gate", () => {
  const allowed = body(`query { viewer { id } }`);

  it("denies GET /graphql naming the method", () => {
    const d = decideLinear("GET", "/graphql", allowed);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("GET");
  });

  it("denies POST /oauth/token even with an allowlisted query body", () => {
    const d = decideLinear("POST", "/oauth/token", allowed);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("/oauth/token");
  });

  it("denies POST /anything", () => {
    const d = decideLinear("POST", "/anything", allowed);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("/anything");
  });

  it("still allows POST /graphql", () => {
    const d = decideLinear("POST", "/graphql", allowed);
    expect(d.decision).toBe("allow");
  });

  it("normalizes the path before matching: query string and dot segments", () => {
    expect(decideLinear("POST", "/graphql?x=1", allowed).decision).toBe(
      "allow",
    );
    expect(decideLinear("POST", "/oauth/../graphql", allowed).decision).toBe(
      "allow",
    );
    expect(decideLinear("POST", "/graphql/../user", allowed).decision).toBe(
      "deny",
    );
  });

  it("rejects the transport before parsing the body", () => {
    const d = decideLinear("GET", "/graphql", "not json at all");
    expect(d.decision).toBe("deny");
    expect(d.reason).not.toContain("JSON");
  });
});

describe("linear graphql catalog", () => {
  it("allows a read query over allowlisted root fields", () => {
    const d = decide(
      body(`query IssuesQuery { issues(first: 3) { nodes { id title } } }`),
    );
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("IssuesQuery");
    expect(d.action).toBe("read");
  });

  it("names the first root field when the operation is anonymous", () => {
    const d = decide(body(`{ viewer { id } }`));
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("viewer");
  });

  it("resolves aliases to the real field name", () => {
    const d = decide(body(`query { myIssues: issues { nodes { id } } }`));
    expect(d.decision).toBe("allow");
  });

  it("denies an alias that hides a non-allowlisted field", () => {
    const d = decide(body(`query { issues: teams { nodes { id } } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("teams");
  });

  it("denies mutations naming the operation type", () => {
    const d = decide(
      body(`mutation Create { issueCreate(input: {}) { success } }`),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("mutation");
  });

  it("denies subscriptions naming the operation type", () => {
    const d = decide(body(`subscription S { issues { id } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("subscription");
  });

  it("denies a root field outside the allowlist, naming the field", () => {
    const d = decide(body(`query { teams { nodes { id } } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("teams");
  });

  it("denies introspection", () => {
    const d = decide(body(`query { __schema { types { name } } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("__schema");
  });

  it("denies a document holding two operations", () => {
    const d = decide(
      body(`query A { viewer { id } } query B { issues { nodes { id } } }`),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("2 operations");
  });

  it("denies malformed graphql with a fixed reason that echoes nothing", () => {
    const d = decide(body(`query { issues {`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("unparseable graphql");
  });

  it("uses the same fixed reason whatever the parser said", () => {
    const a = decide(body(`query { issues {`));
    const b = decide(body(`!!! not graphql at all`));
    expect(b.reason).toBe(a.reason);
  });

  it("denies a named fragment spread at the root", () => {
    const d = decide(
      body(`query { ...Roots } fragment Roots on Query { issues { nodes { id } } }`),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("fragment at root unsupported");
  });

  it("denies an inline fragment at the root", () => {
    const d = decide(
      body(`query { ... on Query { issues { nodes { id } } } }`),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("fragment at root unsupported");
  });

  it("denies a body that is not JSON", () => {
    const d = decide("not json at all");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("body is not JSON");
  });

  it("denies a JSON body without a string query field", () => {
    const d = decide(JSON.stringify({ variables: {} }));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("query");
  });

  it("denies a document with no operation at all", () => {
    const d = decide(body(`fragment F on Query { issues { nodes { id } } }`));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("no operation");
  });

  it("denies a multi-operation document even when operationName picks an allowed one", () => {
    const d = decide(
      body(
        `query A { viewer { id } } query B { teams { nodes { id } } }`,
        "A",
      ),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("2 operations");
  });

  it("never returns a decision without a reason", () => {
    const d = decide(body(`query { projects { nodes { id } } }`));
    expect(d.reason.length).toBeGreaterThan(0);
  });
});
