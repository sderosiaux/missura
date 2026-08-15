import type { MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import { handle } from "./pipeline";
import { bodyText, CLAIMS, harness, request } from "./pipeline.fixtures";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("pipeline — revocation (hot path)", () => {
  it("answers 401 for a revoked jti and never reaches the vendor", async () => {
    const h = harness({ isRevoked: (jti: string): boolean => jti === "jti-1" });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(401);
    expect(h.fetchCount()).toBe(0);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: { code: "missura_unauthorized", reason: "revoked" },
    });
  });

  it("logs the revocation as a deny event carrying the mission id", async () => {
    const h = harness({ isRevoked: (): boolean => true });
    await handle(h.deps, request());

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe("revoked");
    expect(h.events[0]?.missionId).toBe("msn_dev");
  });

  it("re-reads the revocation list on every request — no cache", async () => {
    let revoked = false;
    const h = harness({ isRevoked: (): boolean => revoked });

    const before = await handle(h.deps, request());
    revoked = true;
    const after = await handle(h.deps, request());

    expect(before.status).toBe(200);
    expect(after.status).toBe(401);
    expect(h.fetchCount()).toBe(1);
  });

  it("checks revocation before the catalog", async () => {
    let decideCalls = 0;
    const h = harness({
      isRevoked: (): boolean => true,
      decide: () => {
        decideCalls += 1;
        throw new Error("catalog must not run");
      },
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(401);
    expect(decideCalls).toBe(0);
  });
});

describe("pipeline — traceparent", () => {
  it("forwards the traceparent header unchanged to the vendor", async () => {
    const h = harness();
    await handle(
      h.deps,
      request({
        headers: {
          authorization: "Bearer msr_mission",
          traceparent: TRACEPARENT,
        },
      }),
    );

    const headers = h.calls[0]?.init.headers as Record<string, string>;
    expect(headers.traceparent).toBe(TRACEPARENT);
  });

  it("records the trace-id in the decision event", async () => {
    const h = harness();
    await handle(
      h.deps,
      request({
        headers: {
          authorization: "Bearer msr_mission",
          traceparent: TRACEPARENT,
        },
      }),
    );

    expect(h.events[0]?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("omits the trace-id when the traceparent is malformed", async () => {
    const h = harness();
    await handle(
      h.deps,
      request({
        headers: {
          authorization: "Bearer msr_mission",
          traceparent: "garbage",
        },
      }),
    );

    expect(h.events[0]?.traceId).toBeUndefined();
    const headers = h.calls[0]?.init.headers as Record<string, string>;
    expect(headers.traceparent).toBe("garbage");
  });

  it("omits an all-zero trace-id", async () => {
    const h = harness();
    await handle(
      h.deps,
      request({
        headers: {
          authorization: "Bearer msr_mission",
          traceparent:
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        },
      }),
    );

    expect(h.events[0]?.traceId).toBeUndefined();
  });

  it("carries the trace-id onto a denial event too", async () => {
    const h = harness({ isRevoked: (): boolean => true });
    await handle(
      h.deps,
      request({
        headers: {
          authorization: "Bearer msr_mission",
          traceparent: TRACEPARENT,
        },
      }),
    );

    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });
});

describe("pipeline — provenance in events", () => {
  it("copies actor and purpose from the claims into the event", async () => {
    const h = harness();
    await handle(h.deps, request());

    expect(h.events[0]?.actor).toBe(CLAIMS.actor);
    expect(h.events[0]?.purpose).toBe(CLAIMS.purpose);
  });

  it("keeps provenance on a mission-scoped denial", async () => {
    const scoped: MissionClaims = {
      ...CLAIMS,
      actor: "ops@local",
      purpose: "support case 42",
      connections: ["linear"],
    };
    const h = harness({ verifyToken: (): MissionClaims => scoped });
    await handle(h.deps, request());

    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.actor).toBe("ops@local");
    expect(h.events[0]?.purpose).toBe("support case 42");
  });

  it("leaves provenance out when no claims were established", async () => {
    const h = harness();
    await handle(h.deps, request({ headers: {} }));

    expect(h.events[0]?.actor).toBeUndefined();
    expect(h.events[0]?.purpose).toBeUndefined();
  });
});
