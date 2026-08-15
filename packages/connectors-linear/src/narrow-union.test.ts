import { parse } from "graphql";
import { describe, expect, it } from "vitest";
import { narrowLinear, type LinearNarrowResult } from "./narrow";

/**
 * `ExternalEntityInfo.metadata` is a GraphQL union, and the SDK's `Issue`
 * fragment reaches it through `syncedWith { ...ExternalEntityInfo }` — so how a
 * union is handled decides whether the official SDK works at all.
 *
 * It is walkable because ALL THREE of its members are scalars-only metadata
 * types, which is decidable from the artifact rather than a judgement call. One
 * customer-scoped or unclassified member would make the whole union denied.
 */

const SCOPE = { linearCustomerId: "c_18" };

function request(query: string): string {
  return JSON.stringify({ query });
}

function forwarded(result: LinearNarrowResult, original: string): string {
  if (result.body === undefined) return original;
  const payload = JSON.parse(result.body) as Record<string, unknown>;
  return String(payload.query);
}

describe("narrowLinear — the ExternalEntityInfo union", () => {
  /**
   * A union is entered only through `... on <member>`, and it is walkable
   * because ALL of its members are scalars-only metadata types. The inline
   * fragments are KEPT in the forwarded document — flattening them would print
   * fields directly on a union, which the vendor rejects.
   */
  it("walks the ExternalEntityInfo union through its members", () => {
    const result = narrowLinear(
      request(
        'query { issue(id: "i1") { syncedWith { service metadata { ' +
          "... on ExternalEntityInfoGithubMetadata { repo owner } " +
          "... on ExternalEntitySlackMetadata { channelId } } } } }",
      ),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    const query = forwarded(result, "");
    expect(query).toContain("... on ExternalEntityInfoGithubMetadata");
    expect(() => parse(query)).not.toThrow();
  });

  it("denies a bare field under a union — it would have to guess a member", () => {
    const result = narrowLinear(
      request('query { issue(id: "i1") { syncedWith { metadata { repo } } } }'),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("union");
  });

  it("denies an inline fragment on a type that is not a member", () => {
    const result = narrowLinear(
      request('query { issue(id: "i1") { syncedWith { metadata { ... on Issue { id } } } } }'),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("not a member");
  });
});
