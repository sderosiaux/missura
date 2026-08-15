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

const narrow: NarrowFn = (req) => narrowGithub(req.path, { githubRepos: SCOPE });

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

function vendor(
  body: unknown,
  over: Record<string, string> = {},
): () => Promise<Response> {
  return async (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { ...VENDOR_HEADERS, ...over },
      }),
    );
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

  it("corrects the total to what it actually returns", async () => {
    const h = harness({ narrow }, vendor(MIXED));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(parsed(res.body).total_count).toBe(2);
  });

  it("removes a total that counted more than this page", async () => {
    const h = harness({ narrow }, vendor({ ...MIXED, total_count: 137 }));
    const res = await handle(h.deps, searchRequest(EXPLOIT));

    expect(bodyText(res.body)).not.toContain("137");
    expect(parsed(res.body).total_count).toBeUndefined();
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
