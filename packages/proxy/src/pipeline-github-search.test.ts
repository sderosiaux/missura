import { narrowGithub } from "@missura/connectors-github";
import { describe, expect, it } from "vitest";
import type { NarrowFn } from "./narrow";
import { handle } from "./pipeline";
import { bodyText, harness, request } from "./pipeline.fixtures";

/**
 * The M2 exploit, end to end: `OR` made the forced `repo:` qualifier optional,
 * so M2 refused the query. It now runs, and the response filter is what keeps
 * globex out — plus the vendor headers an SDK needs to retry, minus the one
 * our filtering invalidates.
 */
const SCOPE = ["acme-corp/product", "acme-corp/infra"];

const narrow: NarrowFn = (req) =>
  narrowGithub(req.path, { githubRepos: SCOPE });

const REPOS = "https://api.github.com/repos";

function item(id: number, repo: string): Record<string, unknown> {
  return {
    id,
    title: `issue ${String(id)}`,
    repository_url: `${REPOS}/${repo}`,
  };
}

const VENDOR_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "x-ratelimit-limit": "30",
  "x-ratelimit-remaining": "29",
  "x-ratelimit-reset": "1786802192",
  "x-ratelimit-resource": "search",
  "x-github-request-id": "F282:1D6AAF:282A7A0",
  "retry-after": "60",
  link: `<${REPOS}/x?page=2>; rel="next"`,
  "set-cookie": "session=leak",
  "x-oauth-scopes": "repo, read:org",
};

function raw(
  body: string,
  over: Record<string, string> = {},
): () => Promise<Response> {
  return async (): Promise<Response> =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { ...VENDOR_HEADERS, ...over },
      }),
    );
}

function vendor(
  body: unknown,
  over: Record<string, string> = {},
): () => Promise<Response> {
  return raw(JSON.stringify(body), over);
}

/** Three items, one of them another customer's — as GitHub would answer. */
const MIXED = {
  total_count: 3,
  incomplete_results: false,
  items: [
    item(1, "acme-corp/product"),
    item(2, "globex/secret"),
    item(3, "acme-corp/infra"),
  ],
};

function searchRequest(query: string): ReturnType<typeof request> {
  return request({ path: `/search/issues?q=${encodeURIComponent(query)}` });
}

const EXPLOIT = "is:issue OR repo:globex/secret";

interface SearchBody {
  total_count?: number;
  incomplete_results?: boolean;
  items: { id: number; repository_url: string }[];
}

function parsed(body: string | Uint8Array): SearchBody {
  return JSON.parse(bodyText(body)) as SearchBody;
}

describe("pipeline — GitHub search runs and is filtered", () => {
  it("allows the M2 boolean exploit and returns none of the foreign repo", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(res.status).toBe(200);
    expect(h.fetchCount()).toBe(1);
    expect(bodyText(res.body)).not.toContain("globex");
    expect(parsed(res.body).items.map((i) => i.id)).toEqual([1, 3]);
    expect(h.events[0]?.decision).toBe("allow");
    expect(h.events[0]?.objectsRemoved).toBe(1);
  });

  it("removes the vendor's total rather than correcting it", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(parsed(res.body).total_count).toBeUndefined();
    expect(bodyText(res.body)).not.toContain("total_count");
  });

  /**
   * The global-count oracle, end to end. A `total_count` that survived when it
   * equalled the page made its own presence a function of the vendor's hidden
   * number: `present ⟺ globalTotal ≤ per_page`. Binary-searching `per_page`
   * against `q=<broad> OR repo:globex/secret` then yields the exact count of
   * matches across every repo the vendor credential can reach — with the same
   * zero authorized results returned either way. Two vendor totals, the same
   * authorized items, and the answer must be the same bytes.
   */
  it("answers identically whatever the vendor's total was", async () => {
    const small = harness({ narrow }, vendor({ ...MIXED, total_count: 3 }));
    const huge = harness({ narrow }, vendor({ ...MIXED, total_count: 24_601 }));

    const one = await handle(small.deps, searchRequest(EXPLOIT));
    const two = await handle(huge.deps, searchRequest(EXPLOIT));

    expect(bodyText(one.body)).toBe(bodyText(two.body));
    expect(bodyText(one.body)).not.toContain("24601");
  });

  it("stops claiming the results are complete once it filtered them", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(parsed(res.body).incomplete_results).toBe(true);
  });

  it("keeps results from EVERY repo of a multi-repo mission", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(parsed(res.body).items.map((i) => i.repository_url)).toEqual([
      `${REPOS}/acme-corp/product`,
      `${REPOS}/acme-corp/infra`,
    ]);
  });

  it("runs a quoted phrase the vendor's way and still filters it", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest('"login bug"'));

    const sent = new URL(h.calls[0]?.url ?? "");
    expect(sent.searchParams.get("q")).toBe('"login bug"');
    expect(bodyText(res.body)).not.toContain("globex");
  });

  it("matches the mission repo whatever casing GitHub stored it under", async () => {
    const h = harness(
      { narrow },
      vendor({ ...MIXED, items: [item(1, "Acme-Corp/Product")] }),
    );
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(parsed(res.body).items).toHaveLength(1);
  });
});

describe("pipeline — vendor response headers", () => {
  it("relays the rate-limit budget, the request id and retry-after", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(res.headers["x-ratelimit-limit"]).toBe("30");
    expect(res.headers["x-ratelimit-remaining"]).toBe("29");
    expect(res.headers["x-ratelimit-reset"]).toBe("1786802192");
    expect(res.headers["x-ratelimit-resource"]).toBe("search");
    expect(res.headers["x-github-request-id"]).toBe("F282:1D6AAF:282A7A0");
    expect(res.headers["retry-after"]).toBe("60");
  });

  it("relays nothing the allowlist does not name", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(res.headers["set-cookie"]).toBeUndefined();
    // The vendor credential's own privileges are not the agent's business.
    expect(res.headers["x-oauth-scopes"]).toBeUndefined();
  });

  it("strips `link` on a response a filter plan applied to", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(res.headers.link).toBeUndefined();
  });

  it("strips `link` even when the plan removed nothing — presence is a signal", async () => {
    const h = harness(
      { narrow },
      vendor({ ...MIXED, total_count: 1, items: [item(1, "acme-corp/infra")] }),
    );
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(h.events[0]?.objectsRemoved).toBe(0);
    expect(res.headers.link).toBeUndefined();
  });

  /**
   * A refusal produced on the way back must be as ordinary as an answer. Relay
   * the vendor's headers on the ALLOW and drop them on the fail-closed and the
   * headers themselves become the tell: "no rate-limit budget" would mean "the
   * page I asked for held objects I may not see" — the oracle the vendor-shaped
   * body exists to close.
   */
  it("carries the same vendor headers on a refusal as on an answer", async () => {
    const h = harness(
      { narrow },
      vendor({ total_count: 1, items: { not: "a list" } }),
    );
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(bodyText(res.body)).toBe('{"message":"Not Found"}');
    expect(h.events[0]?.reason).toBe("unfilterable");
    expect(res.headers["x-ratelimit-remaining"]).toBe("29");
    expect(res.headers["x-ratelimit-reset"]).toBe("1786802192");
    expect(res.headers["x-github-request-id"]).toBe("F282:1D6AAF:282A7A0");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers.link).toBeUndefined();
  });

  it("answers a refusal in the vendor's own content-type spelling", async () => {
    const h = harness(
      { narrow },
      vendor(
        { items: { not: "a list" } },
        { "content-type": "application/json; charset=utf-8" },
      ),
    );
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("does not label its own JSON refusal with a content-type that is not JSON", async () => {
    const h = harness(
      { narrow },
      raw("<html>gateway</html>", { "content-type": "text/html" }),
    );
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(res.headers["content-type"]).toBe("application/json");
    expect(bodyText(res.body)).toBe('{"message":"Not Found"}');
  });

  it("keeps `link` on a response no filter plan applied to", async () => {
    const h = harness({ narrow }, vendor({ number: 42 }));
    const res = await handle(
      h.deps,
      request({ path: "/repos/acme-corp/product/issues" }),
    );

    expect(res.headers.link).toBe(`<${REPOS}/x?page=2>; rel="next"`);
    expect(res.headers["x-ratelimit-remaining"]).toBe("29");
  });
});
