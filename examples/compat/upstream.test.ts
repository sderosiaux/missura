import { describe, expect, it } from "vitest";
import { WriteAttemptError } from "./http";
import {
  createRecorder,
  graphqlSignature,
  operationCall,
  targetOf,
} from "./upstream";

/**
 * The recorder is the proxy's only door to the network in this suite, so the
 * read-only promise has to hold THERE too — not just on the calls this suite
 * writes by hand. These run in CI with no credential and no network: nothing
 * below reaches `fetch`, because every case is refused before it would.
 */
describe("the recorded fetch is read-only", () => {
  const recorder = createRecorder(() => undefined);

  it("refuses a write verb the proxy might one day send", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(
        recorder.fetchImpl("https://api.github.com/repos/o/r", { method }),
      ).rejects.toBeInstanceOf(WriteAttemptError);
    }
  });

  it("refuses a GraphQL mutation the proxy might one day forward", async () => {
    await expect(
      recorder.fetchImpl("https://api.linear.app/graphql", {
        method: "POST",
        body: JSON.stringify({ query: "mutation { issueDelete(id: \"x\") { success } }" }),
      }),
    ).rejects.toBeInstanceOf(WriteAttemptError);
  });

  it("records nothing it refused — a refused call never happened", () => {
    expect(recorder.take()).toStrictEqual([]);
  });
});

describe("targetOf", () => {
  it("drops the origin, so no tenant subdomain can reach a committed file", () => {
    expect(
      targetOf("get", "https://acme-support.zendesk.com/api/v2/tickets/7.json?per_page=2"),
    ).toBe("GET /api/v2/tickets/7.json?per_page=2");
  });

  it("describes a GraphQL document, because its rewrite is not in the path", () => {
    const before = targetOf(
      "POST",
      "https://api.linear.app/graphql",
      JSON.stringify({ query: "query { issues { nodes { id } } }" }),
    );
    const after = targetOf(
      "POST",
      "https://api.linear.app/graphql",
      JSON.stringify({
        query: "query { issues(filter: {needs: {some: {}}}) { nodes { id } } }",
      }),
    );
    expect(before).toContain("graphql(issues,");
    expect(after).not.toBe(before);
  });
});

describe("graphqlSignature", () => {
  it("is absent for a request that carries no document", () => {
    expect(graphqlSignature(undefined)).toBeUndefined();
    expect(graphqlSignature("not json")).toBeUndefined();
    expect(graphqlSignature('{"variables":{}}')).toBeUndefined();
  });

  it("says so rather than guessing when the document will not parse", () => {
    expect(graphqlSignature(JSON.stringify({ query: "{{{" }))).toContain(
      "unparseable",
    );
  });
});

/**
 * One agent request can cost several vendor calls. The operation's own call is
 * the one no later call extends — which is what a parent proof always does.
 */
describe("operationCall", () => {
  it("returns the only call there was", () => {
    expect(operationCall(["GET /api/v2/tickets/7.json"])).toBe(
      "GET /api/v2/tickets/7.json",
    );
  });

  it("skips the parent proof probe and returns the child", () => {
    expect(
      operationCall([
        "GET /api/v2/tickets/7",
        "GET /api/v2/tickets/7/comments?per_page=2",
      ]),
    ).toBe("GET /api/v2/tickets/7/comments?per_page=2");
  });

  it("returns the first of several pages, not the last one a refill walked to", () => {
    expect(
      operationCall([
        "GET /api/v2/organizations/1/tickets?page=1",
        "GET /api/v2/organizations/1/tickets?page=2",
      ]),
    ).toBe("GET /api/v2/organizations/1/tickets?page=1");
  });

  it("is undefined when the proxy made no call at all", () => {
    expect(operationCall([])).toBeUndefined();
  });
});
