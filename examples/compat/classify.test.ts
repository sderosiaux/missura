import { describe, expect, it } from "vitest";
import { classify, type ClassifyInput, type OperationSpec } from "./classify";

function spec(over: Partial<OperationSpec> = {}): OperationSpec {
  return {
    operation: "organizations.tickets.list",
    vendor: "zendesk",
    request: "GET /api/v2/organizations/1/tickets.json",
    narrowed: [],
    filtered: [],
    refused: [],
    strips: [],
    ...over,
  };
}

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    spec: spec(),
    direct: { issued: true, status: 200, headers: {}, body: "{}" },
    proxied: { issued: true, status: 200, headers: {}, body: "{}" },
    upstream: undefined,
    agentRequest: "GET /api/v2/organizations/1/tickets.json",
    ...over,
  };
}

describe("classify — the operational definition of “same API”", () => {
  it("calls two identical answers compatible", () => {
    const body = '{"tickets":[{"id":1,"organization_id":7}]}';
    const result = classify(
      input({
        direct: { issued: true, status: 200, headers: {}, body },
        proxied: { issued: true, status: 200, headers: {}, body },
      }),
    );
    expect(result.classification).toBe("compatible");
  });

  it("calls a request the proxy rewrote compatible_with_rewrite", () => {
    const body = '{"results":[]}';
    const result = classify(
      input({
        spec: spec({ operation: "search.list", narrowed: ["organization: forced in"] }),
        agentRequest: "GET /api/v2/search.json?query=type%3Aticket",
        upstream: "GET /api/v2/search.json?query=type%3Aticket+organization%3A7",
        direct: { issued: true, status: 200, headers: {}, body },
        proxied: { issued: true, status: 200, headers: {}, body },
      }),
    );
    expect(result.classification).toBe("compatible_with_rewrite");
    expect(result.observedNarrowing).toBe(
      "GET /api/v2/search.json?query=type%3Aticket+organization%3A7",
    );
  });

  it("calls a shorter list with a declared strip compatible_with_filter", () => {
    const result = classify(
      input({
        spec: spec({ strips: ["next_page"] }),
        direct: {
          issued: true,
          status: 200,
          headers: {},
          body: '{"tickets":[{"id":1},{"id":2}],"next_page":"https://x"}',
        },
        proxied: {
          issued: true,
          status: 200,
          headers: {},
          body: '{"tickets":[{"id":1}]}',
        },
      }),
    );
    expect(result.classification).toBe("compatible_with_filter");
    expect(result.objectsRemoved).toBe(1);
  });

  it("calls a field removed that nobody declared UNSAFE", () => {
    const result = classify(
      input({
        direct: {
          issued: true,
          status: 200,
          headers: {},
          body: '{"tickets":[{"id":1,"subject":"a"}]}',
        },
        proxied: {
          issued: true,
          status: 200,
          headers: {},
          body: '{"tickets":[{"id":1}]}',
        },
      }),
    );
    expect(result.classification).toBe("unsafe");
    expect(result.unsafe).toStrictEqual([
      "field `tickets.*.subject` (string) is gone from the proxied answer and no connector rule declares removing it",
    ]);
  });

  it("calls a nulled field UNSAFE when the connector did not declare it nullable", () => {
    const result = classify(
      input({
        spec: spec({ vendor: "linear", operation: "issue" }),
        direct: {
          issued: true,
          status: 200,
          headers: {},
          body: '{"data":{"issue":{"id":"i1","title":"t"}}}',
        },
        proxied: {
          issued: true,
          status: 200,
          headers: {},
          body: '{"data":{"issue":null}}',
        },
      }),
    );
    expect(result.classification).toBe("unsafe");
    expect(result.unsafe[0]).toContain("data.issue");
  });

  it("calls a declared refusal unsupported when the proxy refuses it vendor-shaped", () => {
    const result = classify(
      input({
        spec: spec({
          operation: "refused.unscoped_listing",
          request: "GET /api/v2/tickets.json",
          refused: ["an account-wide listing is never allowed"],
        }),
        direct: { issued: false, status: 0, headers: {}, body: "" },
        proxied: {
          issued: true,
          status: 403,
          headers: { "content-type": "application/json" },
          body: '{"error":"Forbidden","description":"out of mission scope"}',
        },
      }),
    );
    expect(result.classification).toBe("unsupported");
  });

  it("calls a served refusal UNSAFE — the catalog said never", () => {
    const result = classify(
      input({
        spec: spec({
          operation: "refused.unscoped_listing",
          refused: ["an account-wide listing is never allowed"],
        }),
        direct: { issued: false, status: 0, headers: {}, body: "" },
        proxied: { issued: true, status: 200, headers: {}, body: '{"tickets":[]}' },
      }),
    );
    expect(result.classification).toBe("unsafe");
  });

  it("calls a refusal of a CATALOGED operation UNSAFE — the SDK asked for something we allow", () => {
    const result = classify(
      input({
        direct: {
          issued: true,
          status: 200,
          headers: {},
          body: '{"tickets":[{"id":1}]}',
        },
        proxied: {
          issued: true,
          status: 404,
          headers: { "content-type": "application/json" },
          body: '{"error":"RecordNotFound","description":"Not found"}',
        },
      }),
    );
    expect(result.classification).toBe("unsafe");
    expect(result.unsafe[0]).toContain("the vendor answered 200");
  });

  it("calls an error body the vendor's SDK cannot parse UNSAFE", () => {
    const result = classify(
      input({
        spec: spec({ refused: ["never allowed"] }),
        direct: { issued: false, status: 0, headers: {}, body: "" },
        proxied: {
          issued: true,
          status: 403,
          headers: { "content-type": "text/plain" },
          body: "forbidden",
        },
      }),
    );
    expect(result.classification).toBe("unsafe");
    expect(result.unsafe[0]).toContain("not JSON");
  });

  it("calls a status no vendor SDK expects UNSAFE", () => {
    const result = classify(
      input({
        direct: { issued: true, status: 200, headers: {}, body: "{}" },
        proxied: {
          issued: true,
          status: 502,
          headers: { "content-type": "application/json" },
          body: '{"error":"upstream","description":"x"}',
        },
      }),
    );
    expect(result.classification).toBe("unsafe");
    expect(result.unsafe.join(" ")).toContain("502");
  });

  it("does not call a dropped rate-limit header unsafe — headers are not typed", () => {
    const result = classify(
      input({
        direct: {
          issued: true,
          status: 200,
          headers: { link: "<...>; rel=\"next\"", "content-type": "application/json" },
          body: '{"tickets":[]}',
        },
        proxied: {
          issued: true,
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"tickets":[]}',
        },
      }),
    );
    expect(result.classification).toBe("compatible");
    expect(result.notes).toContain("vendor headers not relayed: link");
  });

  it("calls a changed content-type UNSAFE — an SDK branches on it", () => {
    const result = classify(
      input({
        direct: {
          issued: true,
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: "{}",
        },
        proxied: {
          issued: true,
          status: 200,
          headers: { "content-type": "text/html" },
          body: "{}",
        },
      }),
    );
    expect(result.classification).toBe("unsafe");
  });
});
