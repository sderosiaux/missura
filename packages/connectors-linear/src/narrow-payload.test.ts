import { describe, expect, it } from "vitest";
import { narrowLinear } from "./narrow";

/**
 * `extensions` is the one field of a GraphQL POST that can change WHICH
 * document runs, and nothing downstream of NARROW re-reads it. So it never
 * reaches the vendor, whatever it holds.
 */

const SCOPE = { linearCustomerId: "c_18" };

function request(query: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ query, ...extra });
}

describe("narrowLinear — extensions never reach the vendor", () => {
  const query = "query { viewer { id } }";

  it("denies a persisted-query hash", () => {
    const result = narrowLinear(
      request(query, {
        extensions: { persistedQuery: { version: 1, sha256Hash: "deadbeef" } },
      }),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("persisted query not supported");
  });

  it("strips a benign extensions block from the forwarded body", () => {
    const result = narrowLinear(request(query, { extensions: { tracing: true } }), SCOPE);
    expect(result.decision).toBe("allow");
    const payload = JSON.parse(result.body ?? "") as Record<string, unknown>;
    expect(payload.extensions).toBeUndefined();
    expect("extensions" in payload).toBe(false);
    expect(payload.query).toBeTypeOf("string");
  });

  it("strips extensions from a rewritten issues document too", () => {
    const result = narrowLinear(
      request("query { issues { nodes { id } } }", { extensions: { foo: 1 } }),
      SCOPE,
    );
    const payload = JSON.parse(result.body ?? "") as Record<string, unknown>;
    expect("extensions" in payload).toBe(false);
    expect(String(payload.query)).toContain("c_18");
  });
});
