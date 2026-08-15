import type { CatalogDecision, MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import { handle } from "./pipeline";
import {
  ALLOW,
  DENY,
  VENDOR_HEADER,
  bodyText,
  harness,
  request,
  restDenial,
} from "./pipeline.fixtures";

describe("pipeline — authn (step 1)", () => {
  it("rejects a missing Authorization header with 401 and never calls upstream", async () => {
    const h = harness();
    const res = await handle(h.deps, request({ headers: {} }));

    expect(res.status).toBe(401);
    expect(h.fetchCount()).toBe(0);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(restDenial(res.body).code).toBe("missura_unauthenticated");
  });

  it("rejects a non-Bearer Authorization header with 401 and never calls upstream", async () => {
    const h = harness();
    const res = await handle(
      h.deps,
      request({ headers: { authorization: "Basic abc" } }),
    );

    expect(res.status).toBe(401);
    expect(h.fetchCount()).toBe(0);
  });

  it("rejects an invalid/expired token with 401 and never calls upstream", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => {
        throw new Error("token expired");
      },
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(401);
    expect(h.fetchCount()).toBe(0);
  });

  it("emits a deny event with reason authn and never calls the catalog", async () => {
    let decideCalls = 0;
    const h = harness({
      decide: (): CatalogDecision => {
        decideCalls += 1;
        return ALLOW;
      },
    });
    await handle(h.deps, request({ headers: {} }));

    expect(decideCalls).toBe(0);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toContain("authn");
    expect(h.events[0]?.provider).toBe("github");
  });
});

describe("pipeline — catalog deny (step 2)", () => {
  it("answers 403 with the catalog reason and never calls upstream", async () => {
    const h = harness({ decide: (): CatalogDecision => DENY });
    const res = await handle(h.deps, request({ path: "/user" }));

    expect(res.status).toBe(403);
    expect(h.fetchCount()).toBe(0);
    expect(restDenial(res.body)).toMatchObject({
      code: "missura_operation_not_in_catalog",
      reason: DENY.reason,
    });
    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("logs the denial event with the catalog operation and reason", async () => {
    const h = harness({ decide: (): CatalogDecision => DENY });
    await handle(h.deps, request({ path: "/user" }));

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe(DENY.reason);
    expect(h.events[0]?.missionId).toBe("msn_dev");
  });

  it("passes method, path and body to the catalog", async () => {
    const seen: { method: string; path: string; body: string }[] = [];
    const h = harness({
      decide: (req): CatalogDecision => {
        seen.push(req);
        return DENY;
      },
    });
    await handle(
      h.deps,
      request({ method: "POST", path: "/graphql?x=1", body: '{"query":"{}"}' }),
    );

    expect(seen).toEqual([
      { method: "POST", path: "/graphql?x=1", body: '{"query":"{}"}' },
    ]);
  });
});

describe("pipeline — allow + forward (step 3)", () => {
  it("forwards to the upstream base keeping method, path, query and body", async () => {
    const h = harness();
    await handle(
      h.deps,
      request({
        method: "POST",
        path: "/graphql?first=3",
        body: '{"query":"{ viewer { id } }"}',
      }),
    );

    expect(h.calls[0]?.url).toBe("https://api.github.com/graphql?first=3");
    expect(h.calls[0]?.init.method).toBe("POST");
    expect(h.calls[0]?.init.body).toBe('{"query":"{ viewer { id } }"}');
  });

  it("replaces Authorization with the vendor credential and drops host", async () => {
    const h = harness();
    await handle(
      h.deps,
      request({
        headers: {
          authorization: "Bearer msr_mission",
          host: "localhost:8482",
        },
      }),
    );

    const headers = h.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(VENDOR_HEADER);
    expect(Object.keys(headers)).not.toContain("host");
  });

  it("passes other client headers through but drops hop-by-hop headers", async () => {
    const h = harness();
    await handle(
      h.deps,
      request({
        headers: {
          authorization: "Bearer msr_mission",
          "user-agent": "octokit/1.0",
          "content-length": "0",
          connection: "keep-alive",
        },
      }),
    );

    const headers = h.calls[0]?.init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe("octokit/1.0");
    expect(Object.keys(headers)).not.toContain("content-length");
    expect(Object.keys(headers)).not.toContain("connection");
  });

  it("returns the upstream status, content-type and body verbatim", async () => {
    const h = harness({}, async () =>
      Promise.resolve(
        new Response('{"data":{"viewer":{"id":"u1"}}}', {
          status: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      ),
    );
    const res = await handle(h.deps, request());

    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(bodyText(res.body)).toBe('{"data":{"viewer":{"id":"u1"}}}');
  });

  it("emits an allow event with the catalog operation and a latency", async () => {
    const h = harness();
    await handle(h.deps, request());

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.decision).toBe("allow");
    expect(h.events[0]?.operation).toBe("repos.get");
    expect(h.events[0]?.action).toBe("read");
    expect(h.events[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
