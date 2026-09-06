import { describe, expect, it } from "vitest";
import type { NarrowFn } from "./narrow";
import { executeOperation, OPERATION_ROUTE, operationName } from "./operations";
import { NOW, post, result, rig, TRACE_ID } from "./operations.fixtures";
import { handle } from "./pipeline";
import { ALLOW, bodyText, CLAIMS, request } from "./pipeline.fixtures";
import type { ResponseShape } from "./transport";

/**
 * THE M7 PROPERTY: missura executing an operation is not missura bypassing
 * itself. Every vendor call an operation makes is handed to the same `handle`
 * a raw agent request goes through — the connector's own catalog, NARROW,
 * FILTER, refusals and audit record — and the tests here are written so that
 * an executor calling `fetch` directly would fail them one by one: the
 * narrowed path would not appear, the inner decision events would not exist,
 * and the inner refusal would not be the raw call's bytes.
 */

describe("operationName — POST /missura/op/<name>", () => {
  it("reads the name off the route, query string dropped", () => {
    expect(operationName(post("zendesk.tickets.for_entity"))).toBe(
      "zendesk.tickets.for_entity",
    );
    expect(
      operationName(request({ method: "POST", path: `${OPERATION_ROUTE}a.b?x=1` })),
    ).toBe("a.b");
  });

  it("is not the route on any other method, or with no name", () => {
    expect(operationName(request({ method: "GET", path: `${OPERATION_ROUTE}a.b` }))).toBe(
      undefined,
    );
    expect(operationName(request({ method: "POST", path: OPERATION_ROUTE }))).toBe(
      undefined,
    );
    expect(operationName(request({ method: "POST", path: "/missura/opx" }))).toBe(
      undefined,
    );
  });
});

describe("the executor runs every inner call through the pipeline", () => {
  it("hands each step to the connector's own pipeline: narrowed, credentialed, logged", async () => {
    const { outer, github } = rig();
    const res = await handle(outer.deps, post("github.issues.for_entity"));

    expect(res.status).toBe(200);
    // Both repositories asked, in plan order, each on the NARROWED path — the
    // mark only NARROW puts there — and with the vendor's own credential.
    expect(github.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme-corp/product/issues?state=open&narrowed=1",
      "https://api.github.com/repos/acme-corp/infra/issues?state=open&narrowed=1",
    ]);
    for (const call of github.calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(github.deps.vendorAuthHeader());
      // The agent's trace rides along, so one operation is one trace end to end.
      expect(headers.get("traceparent")).toContain(TRACE_ID);
    }
    // The listener the agent aimed at never spoke to any vendor.
    expect(outer.fetchCount()).toBe(0);
  });

  it("composes the inner answers in plan order, under the operation's name", async () => {
    const { outer } = rig();
    const res = await handle(outer.deps, post("github.issues.for_entity"));

    expect(res.headers["content-type"]).toBe("application/json");
    expect(result(res)).toEqual({
      operation: "github.issues.for_entity",
      effect: "read",
      results: ["upstream ok", "upstream ok"],
    });
  });

  it("writes one decision event per inner call, attributed to the mission and the operation", async () => {
    const { outer, github } = rig();
    await handle(outer.deps, post("github.issues.for_entity"));

    // The inner records are the connector's own — its catalog operation, its
    // provider — plus the operation they served.
    expect(github.events).toHaveLength(2);
    for (const ev of github.events) {
      expect(ev).toMatchObject({
        provider: "github",
        decision: "allow",
        operation: ALLOW.operation,
        action: "read",
        missionId: CLAIMS.id,
        actor: CLAIMS.actor,
        purpose: CLAIMS.purpose,
        viaOperation: "github.issues.for_entity",
        traceId: TRACE_ID,
      });
    }
    // And the operation itself is a decision on the listener that took it.
    expect(outer.events).toHaveLength(1);
    expect(outer.events[0]).toMatchObject({
      provider: "linear",
      decision: "allow",
      operation: "missura.op",
      action: "read",
      viaOperation: "github.issues.for_entity",
      missionId: CLAIMS.id,
    });
  });

  it("returns an inner refusal verbatim — the raw call's own bytes", async () => {
    const refusing: NarrowFn = () => ({
      decision: "deny",
      denyShape: "github404",
      reason: "out of scope",
      missionScopeSize: 2,
    });
    const { outer, github } = rig({ githubNarrow: refusing });
    const op = await handle(outer.deps, post("github.issues.for_entity"));
    const raw = await handle(
      github.deps,
      request({ method: "GET", path: "/repos/acme-corp/product/issues?state=open" }),
    );

    expect(op.status).toBe(404);
    expect(op.status).toBe(raw.status);
    expect(bodyText(op.body)).toBe(bodyText(raw.body));
    expect(op.headers).toEqual(raw.headers);
    expect(github.fetchCount()).toBe(0);
    expect(outer.events[0]).toMatchObject({ decision: "deny", operation: "missura.op" });
  });
});

describe("the reduced marker crosses the composition", () => {
  const ctx = { missionId: CLAIMS.id, startedAt: NOW, viaOperation: "x" };

  /** A `run` standing in for the pipeline, answering what it is told to. */
  function runWith(
    answers: readonly ResponseShape[],
  ): Parameters<typeof executeOperation>[5] {
    let i = 0;
    return (): Promise<ResponseShape> => {
      const answer = answers[i++];
      if (answer === undefined) throw new Error("no answer left");
      return Promise.resolve(answer);
    };
  }

  it("is set when any inner call was reduced — one boolean, never a count", async () => {
    const { outer } = rig();
    const res = await executeOperation(
      outer.deps,
      post("github.issues.for_entity"),
      ctx,
      CLAIMS,
      "github.issues.for_entity",
      runWith([
        { status: 200, headers: {}, body: '{"a":1}' },
        { status: 200, headers: { "missura-reduced": "true" }, body: '{"b":2}' },
      ]),
    );
    expect(result(res)).toEqual({
      operation: "github.issues.for_entity",
      effect: "read",
      results: [{ a: 1 }, { b: 2 }],
      reduced: true,
    });
  });

  it("is absent when nothing was reduced", async () => {
    const { outer } = rig();
    const res = await executeOperation(
      outer.deps,
      post("github.issues.for_entity"),
      ctx,
      CLAIMS,
      "github.issues.for_entity",
      runWith([
        { status: 200, headers: {}, body: '{"a":1}' },
        { status: 200, headers: {}, body: '{"b":2}' },
      ]),
    );
    expect("reduced" in result(res)).toBe(false);
  });
});
