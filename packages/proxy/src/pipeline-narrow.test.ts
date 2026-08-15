import type { MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import type { NarrowResult } from "./narrow";
import { handle } from "./pipeline";
import {
  bodyText,
  CLAIMS,
  harness,
  request,
  restDenial,
} from "./pipeline.fixtures";

const CUSTOMER_PATH = ["data", "issue", "customer", "id"];

function graphql(body: unknown): () => Promise<Response> {
  return async (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

describe("pipeline — narrow seam", () => {
  it("forwards untouched under the default pass-through narrow", async () => {
    const h = harness();
    const res = await handle(h.deps, request({ path: "/repos/octo/hello" }));

    expect(res.status).toBe(200);
    expect(h.calls[0]?.url).toBe("https://api.github.com/repos/octo/hello");
  });

  it("hands narrow the request and the claims, after the catalog", async () => {
    const seen: { path: string; body: string; actor: string }[] = [];
    const h = harness({
      narrow: (req, claims: MissionClaims): NarrowResult => {
        seen.push({ path: req.path, body: req.body, actor: claims.actor });
        return { decision: "allow" };
      },
    });
    await handle(
      h.deps,
      request({ method: "POST", path: "/graphql", body: '{"query":"{}"}' }),
    );

    expect(seen).toEqual([
      { path: "/graphql", body: '{"query":"{}"}', actor: CLAIMS.actor },
    ]);
  });

  it("denies with the narrow reason and never reaches the vendor", async () => {
    const h = harness({
      narrow: (): NarrowResult => ({
        decision: "deny",
        reason: "no proven relation to mission customer",
      }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(403);
    expect(h.fetchCount()).toBe(0);
    expect(restDenial(res.body)).toMatchObject({
      code: "missura_out_of_mission_scope",
      reason: "no proven relation to mission customer",
    });
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe("no proven relation to mission customer");
  });

  it("answers a GitHub-shaped 404 when narrow asks for it", async () => {
    const h = harness({
      narrow: (): NarrowResult => ({
        decision: "deny",
        denyShape: "github404",
        reason: "repo not in mission",
      }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("application/json");
    // GitHub's own not-found at the top level, so it still reads as absence;
    // the actionable part rides underneath, built from the mission alone.
    expect(
      (JSON.parse(bodyText(res.body)) as { message: string }).message,
    ).toBe("Not Found");
    expect(restDenial(res.body).code).toBe("missura_out_of_mission_scope");
    expect(h.fetchCount()).toBe(0);
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe("repo not in mission");
  });

  it("forwards the rewritten path and body", async () => {
    const h = harness({
      narrow: (): NarrowResult => ({
        decision: "allow",
        path: "/search/issues?q=bug+repo%3Aacme-corp%2Fproduct",
        body: '{"query":"narrowed"}',
      }),
    });
    await handle(
      h.deps,
      request({ method: "POST", path: "/search/issues?q=bug" }),
    );

    expect(h.calls[0]?.url).toBe(
      "https://api.github.com/search/issues?q=bug+repo%3Aacme-corp%2Fproduct",
    );
    expect(h.calls[0]?.init.body).toBe('{"query":"narrowed"}');
  });

  it("refuses a rewritten path that would leave the vendor origin", async () => {
    const h = harness({
      narrow: (): NarrowResult => ({
        decision: "allow",
        path: "https://evil.example/steal",
      }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(403);
    expect(h.fetchCount()).toBe(0);
  });
});

describe("pipeline — narrow post-check", () => {
  const postCheck = {
    path: CUSTOMER_PATH,
    expectedCustomerId: "c_18",
    injectedSelection: "relation",
  } as const;
  const narrow = (): NarrowResult => ({ decision: "allow", postCheck });

  it("replaces an out-of-scope object with a 404-shaped GraphQL error", async () => {
    const h = harness(
      { narrow },
      graphql({ data: { issue: { id: "i1", customer: { id: "c_globex" } } } }),
    );
    const res = await handle(h.deps, request());

    expect(h.fetchCount()).toBe(1);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      errors: [{ message: "issue not found" }],
    });
    expect(bodyText(res.body)).not.toContain("c_globex");
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe("out-of-scope object");
  });

  it("strips the whole relation it injected when the object is in scope", async () => {
    const h = harness(
      { narrow },
      graphql({
        data: { issue: { id: "i1", customer: { id: "c_18" } } },
      }),
    );
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual({
      data: { issue: { id: "i1" } },
    });
    expect(h.events[0]?.decision).toBe("allow");
  });

  it("keeps a selection the agent asked for itself", async () => {
    const h = harness(
      {
        narrow: (): NarrowResult => ({
          decision: "allow",
          postCheck: { ...postCheck, injectedSelection: "none" },
        }),
      },
      graphql({ data: { issue: { id: "i1", customer: { id: "c_18" } } } }),
    );
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual({
      data: { issue: { id: "i1", customer: { id: "c_18" } } },
    });
  });

  it("strips only the `id` when the agent asked for the relation itself", async () => {
    // NARROW widened `customer { name }` to `customer { name id }`: the `id` is
    // ours, the `customer` key is the agent's. Removing the whole relation
    // would take away what it asked for; leaving the `id` hands it a field it
    // never asked for.
    const h = harness(
      {
        narrow: (): NarrowResult => ({
          decision: "allow",
          postCheck: { ...postCheck, injectedSelection: "id" },
        }),
      },
      graphql({
        data: { issue: { id: "i1", customer: { name: "Acme", id: "c_18" } } },
      }),
    );
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual({
      data: { issue: { id: "i1", customer: { name: "Acme" } } },
    });
    expect(h.events[0]?.decision).toBe("allow");
  });

  it("passes a null object through — the vendor returned nothing to leak", async () => {
    const h = harness({ narrow }, graphql({ data: { issue: null } }));
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual({ data: { issue: null } });
    expect(h.events[0]?.decision).toBe("allow");
  });

  it("fails closed when the ownership field is missing", async () => {
    const h = harness({ narrow }, graphql({ data: { issue: { id: "i1" } } }));
    const res = await handle(h.deps, request());

    expect(JSON.parse(bodyText(res.body))).toEqual({
      errors: [{ message: "issue not found" }],
    });
    expect(h.events[0]?.decision).toBe("deny");
  });

  it("fails closed when the response is not JSON", async () => {
    const h = harness({ narrow });
    const res = await handle(h.deps, request());

    expect(bodyText(res.body)).toBe(
      '{"errors":[{"message":"issue not found"}]}',
    );
    expect(h.events[0]?.decision).toBe("deny");
  });
});
