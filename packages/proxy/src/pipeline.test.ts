import type { CatalogDecision, MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import { handle, MAX_RESPONSE_BYTES } from "./pipeline";
import {
  ALLOW,
  DENY,
  VENDOR_HEADER,
  bodyText,
  harness,
  request,
} from "./pipeline.fixtures";

describe("pipeline — authn (step 1)", () => {
  it("rejects a missing Authorization header with 401 and never calls upstream", async () => {
    const h = harness();
    const res = await handle(h.deps, request({ headers: {} }));

    expect(res.status).toBe(401);
    expect(h.fetchCount()).toBe(0);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: { code: "missura_unauthorized" },
    });
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
  it("answers 403 missura_denied with the catalog reason and never calls upstream", async () => {
    const h = harness({ decide: (): CatalogDecision => DENY });
    const res = await handle(h.deps, request({ path: "/user" }));

    expect(res.status).toBe(403);
    expect(h.fetchCount()).toBe(0);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: { code: "missura_denied", reason: DENY.reason },
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

/**
 * A vendor double whose body is a stream: `pulls` counts how many chunks the
 * proxy actually asked for, so a test can prove the cap stopped the read
 * instead of buffering the whole payload and checking the size afterwards.
 */
function streamed(
  totalBytes: number,
  chunkBytes: number,
  headers: Record<string, string> = {},
): {
  response: () => Promise<Response>;
  pulls: () => number;
  cancelled: () => boolean;
} {
  let pulls = 0;
  let cancelled = false;
  const response = async (): Promise<Response> => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls += 1;
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkBytes, totalBytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  };
  return {
    response,
    pulls: (): number => pulls,
    cancelled: (): boolean => cancelled,
  };
}

const OVER_CAP = MAX_RESPONSE_BYTES + 1;

describe("pipeline — upstream response cap (10 MB)", () => {
  it("caps at 10 MB", () => {
    expect(MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("refuses an oversized content-length with 502 without reading the body", async () => {
    const upstream = streamed(OVER_CAP, 64 * 1024, {
      "content-length": String(OVER_CAP),
    });
    const h = harness({}, upstream.response);

    const res = await handle(h.deps, request());

    expect(res.status).toBe(502);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: { code: "missura_response_too_large" },
    });
    // One chunk may be pulled by the stream's own queuing strategy before the
    // proxy ever sees the response; what matters is that the proxy dropped the
    // body instead of draining 11 MB of it.
    expect(upstream.pulls()).toBeLessThanOrEqual(1);
    expect(upstream.cancelled()).toBe(true);
  });

  it("aborts a chunked oversized response mid-stream with 502", async () => {
    // 30 MB with no content-length: reading it whole would take ~31 pulls.
    const upstream = streamed(3 * MAX_RESPONSE_BYTES, 1024 * 1024);
    const h = harness({}, upstream.response);

    const res = await handle(h.deps, request());

    expect(res.status).toBe(502);
    expect(JSON.parse(bodyText(res.body))).toEqual({
      error: { code: "missura_response_too_large" },
    });
    // The read stops just past the cap instead of buffering the whole body.
    expect(upstream.pulls()).toBeLessThan(20);
  });

  it("records the oversized response as a deny naming the upstream call", async () => {
    const upstream = streamed(OVER_CAP, 1024 * 1024);
    const h = harness({}, upstream.response);

    await handle(h.deps, request());

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.decision).toBe("deny");
    expect(h.events[0]?.reason).toBe(
      "response too large (after upstream call)",
    );
    expect(h.events[0]?.operation).toBe("repos.get");
  });

  it("passes a 1 MB response through byte-for-byte", async () => {
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const h = harness({}, async () =>
      Promise.resolve(
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const res = await handle(h.deps, request());

    expect(res.status).toBe(200);
    // Compared as buffers on purpose: a failed element-wise assertion on a
    // megabyte of bytes would try to pretty-print it.
    expect(Buffer.from(res.body).equals(Buffer.from(payload))).toBe(true);
    expect(h.events[0]?.decision).toBe("allow");
  });

  it("passes a response exactly at the cap through", async () => {
    const upstream = streamed(MAX_RESPONSE_BYTES, 1024 * 1024);
    const h = harness({}, upstream.response);

    const res = await handle(h.deps, request());

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(MAX_RESPONSE_BYTES);
  });
});
