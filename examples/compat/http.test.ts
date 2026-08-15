import { describe, expect, it } from "vitest";
import { assertQueryOnly, assertReadOnly, WriteAttemptError } from "./http";

/**
 * The read-only promise, asserted rather than described. These run in CI, with
 * no credential and no network, so the guard is proven before anyone points
 * this suite at their own workspace.
 */
describe("assertReadOnly", () => {
  it("allows the read verbs", () => {
    for (const verb of ["GET", "get", "HEAD", "OPTIONS"]) {
      expect(() => {
        assertReadOnly(verb, "https://api.github.com/repos/o/r", undefined);
      }).not.toThrow();
    }
  });

  it("refuses every write verb, on any host", () => {
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => {
        assertReadOnly(verb, "https://api.github.com/repos/o/r", "{}");
      }).toThrow(WriteAttemptError);
    }
  });

  it("allows a POST only to a GraphQL endpoint, and only for a query", () => {
    expect(() => {
      assertReadOnly(
        "POST",
        "https://api.linear.app/graphql",
        JSON.stringify({ query: "query { viewer { id } }" }),
      );
    }).not.toThrow();
  });

  it("refuses a mutation posted to the GraphQL endpoint", () => {
    expect(() => {
      assertReadOnly(
        "POST",
        "https://api.linear.app/graphql",
        JSON.stringify({ query: "mutation { issueCreate(input: {}) { success } }" }),
      );
    }).toThrow(/refusing to send a GraphQL mutation/);
  });

  it("refuses a mutation hidden behind a query in the same document", () => {
    expect(() => {
      assertQueryOnly("query A { viewer { id } } mutation B { issueDelete(id: \"x\") { success } }");
    }).toThrow(WriteAttemptError);
  });

  it("refuses a document it cannot parse rather than guessing", () => {
    expect(() => {
      assertQueryOnly("{{{ not graphql");
    }).toThrow(/cannot parse/);
  });

  it("refuses a GraphQL POST whose body carries no readable query", () => {
    expect(() => {
      assertReadOnly("POST", "https://api.linear.app/graphql", '{"variables":{}}');
    }).toThrow(/no readable `query`/);
  });
});
