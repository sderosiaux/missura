import type { CatalogDecision, MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import { handle, type IncomingShape, type PipelineDeps } from "./pipeline";
import {
  ALLOW,
  CLAIMS,
  DENY,
  VENDOR_HEADER,
  VENDOR_SECRET,
  bodyText,
  harness,
  request,
} from "./pipeline.fixtures";

describe("pipeline — upstream failure (step 4)", () => {
  it("answers 502 missura_upstream_error without any vendor or upstream detail", async () => {
    const h = harness({}, () =>
      Promise.reject(
        new Error(`connect ECONNREFUSED api.github.com with ${VENDOR_HEADER}`),
      ),
    );
    const res = await handle(h.deps, request());

    expect(res.status).toBe(502);
    const payload: unknown = JSON.parse(bodyText(res.body));
    expect(payload).toEqual({ error: { code: "missura_upstream_error" } });
    expect(bodyText(res.body)).not.toContain("ECONNREFUSED");
    expect(bodyText(res.body)).not.toContain("api.github.com");
  });

  it("emits an event for the failed upstream call without vendor detail", async () => {
    const h = harness({}, () =>
      Promise.reject(new Error(`boom ${VENDOR_SECRET}`)),
    );
    await handle(h.deps, request());

    expect(h.events).toHaveLength(1);
    expect(JSON.stringify(h.events)).not.toContain(VENDOR_SECRET);
  });
});

describe("pipeline — the vendor credential never escapes (step 5)", () => {
  const cases: {
    name: string;
    over: Partial<PipelineDeps>;
    req: IncomingShape;
  }[] = [
    { name: "401", over: {}, req: request({ headers: {} }) },
    {
      name: "403",
      over: { decide: (): CatalogDecision => DENY },
      req: request({ path: "/user" }),
    },
    { name: "200", over: {}, req: request() },
  ];

  for (const c of cases) {
    it(`never leaks the credential into the event or the body (${c.name})`, async () => {
      const h = harness(c.over);
      const res = await handle(h.deps, c.req);

      expect(JSON.stringify(h.events)).not.toContain(VENDOR_SECRET);
      expect(JSON.stringify(res.body)).not.toContain(VENDOR_SECRET);
      expect(JSON.stringify(res.headers)).not.toContain(VENDOR_SECRET);
      expect(bodyText(res.body)).not.toContain(VENDOR_SECRET);
    });
  }
});

describe("pipeline — the mission claims are enforced", () => {
  it("denies a provider absent from claims.connections without calling upstream", async () => {
    const h = harness({
      provider: "github",
      verifyToken: (): MissionClaims => ({
        ...CLAIMS,
        connections: ["linear"],
      }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(403);
    expect(h.fetchCount()).toBe(0);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: {
        code: "missura_denied",
        reason: "connection not in mission",
      },
    });
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe("connection not in mission");
  });

  it("never consults the catalog when the connection is not in the mission", async () => {
    let decideCalls = 0;
    const h = harness({
      verifyToken: (): MissionClaims => ({ ...CLAIMS, connections: [] }),
      decide: (): CatalogDecision => {
        decideCalls += 1;
        return ALLOW;
      },
    });
    await handle(h.deps, request());

    expect(decideCalls).toBe(0);
  });

  it("denies an allowed operation whose action is not in claims.allow", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => ({ ...CLAIMS, allow: ["search"] }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(403);
    expect(h.fetchCount()).toBe(0);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: {
        code: "missura_denied",
        reason: "action not allowed by mission",
      },
    });
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.operation).toBe(ALLOW.operation);
  });

  it("leaves the allow path untouched when the claims cover it", async () => {
    const h = harness();
    const res = await handle(h.deps, request());

    expect(res.status).toBe(200);
    expect(h.fetchCount()).toBe(1);
    expect(h.events[0]?.decision).toBe("allow");
  });
});

describe("pipeline — the request target cannot move the origin", () => {
  const escapes = ["https://evil.com/repos/o/r", "//evil.com/repos/o/r"];

  for (const path of escapes) {
    it(`denies the request target ${path} without calling upstream`, async () => {
      const h = harness();
      const res = await handle(h.deps, request({ path }));

      expect(res.status).toBe(403);
      expect(h.fetchCount()).toBe(0);
      expect(JSON.parse(bodyText(res.body))).toEqual({
        error: {
          code: "missura_denied",
          reason: "path escapes upstream origin",
        },
      });
    });

    it(`logs the denial for ${path}`, async () => {
      const h = harness();
      await handle(h.deps, request({ path }));

      expect(h.events).toHaveLength(1);
      expect(h.events[0]?.decision).toBe("deny");
      expect(h.events[0]?.reason).toBe("path escapes upstream origin");
    });
  }

  it("still forwards a normal path to the upstream origin", async () => {
    const h = harness();
    const res = await handle(h.deps, request({ path: "/repos/o/r" }));

    expect(res.status).toBe(200);
    expect(h.fetchCount()).toBe(1);
    const url = new URL(h.calls[0]?.url ?? "");
    expect(url.origin).toBe(new URL(h.deps.upstreamBase).origin);
    expect(url.pathname).toBe("/repos/o/r");
  });
});

describe("pipeline — fail closed", () => {
  it("answers 500 missura_internal and never forwards when decide() throws", async () => {
    const h = harness({
      decide: (): CatalogDecision => {
        throw new Error("catalog blew up");
      },
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(500);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: { code: "missura_internal" },
    });
    expect(h.fetchCount()).toBe(0);
    expect(bodyText(res.body)).not.toContain("catalog blew up");
  });

  it("answers 500 and never forwards when emit() throws on a denied request", async () => {
    const h = harness({
      decide: (): CatalogDecision => DENY,
      emit: (): void => {
        throw new Error("disk full");
      },
    });
    const res = await handle(h.deps, request({ path: "/user" }));

    expect(res.status).toBe(500);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: { code: "missura_internal" },
    });
    expect(h.fetchCount()).toBe(0);
  });

  it("answers 500 without the upstream payload when emit() throws after a forward", async () => {
    const h = harness({
      emit: (): void => {
        throw new Error("disk full");
      },
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(500);
    expect(bodyText(res.body)).not.toContain("upstream ok");
  });
});
