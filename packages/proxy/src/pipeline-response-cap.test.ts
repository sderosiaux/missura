import { describe, expect, it } from "vitest";
import { handle, MAX_RESPONSE_BYTES } from "./pipeline";
import { harness, request, restDenial } from "./pipeline.fixtures";

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
    expect(restDenial(res.body).code).toBe("missura_response_too_large");
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
    expect(restDenial(res.body).code).toBe("missura_response_too_large");
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
