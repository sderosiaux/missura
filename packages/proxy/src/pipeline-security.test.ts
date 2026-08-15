import type { CatalogDecision } from "@missura/core";
import { describe, expect, it } from "vitest";
import { handle, type IncomingShape, type PipelineDeps } from "./pipeline";
import {
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
