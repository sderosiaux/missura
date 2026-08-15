import { narrowGithub } from "@missura/connectors-github";
import { describe, expect, it } from "vitest";
import type { NarrowFn } from "./narrow";
import { handle } from "./pipeline";
import { bodyText, harness, request } from "./pipeline.fixtures";
import { MAX_REFILL_CALLS } from "./refill";

/**
 * REFILL over GitHub's REST search, which paginates with `page`/`per_page`
 * QUERY parameters rather than a Relay cursor in the request body.
 *
 * Without it, `/search/issues` filtered without refilling, and the short page
 * was a per-index oracle: `per_page=1&page=N&sort=created&order=asc` walked the
 * exact interleaving of a foreign repo's issues against the agent's own — their
 * count and their approximate dates — because an empty answer at index N meant
 * "the object at index N is not yours". M2 refused this query outright, so
 * answering it without refilling was a regression in reachable information.
 */

const SCOPE = [{ repo: "acme-corp/product" }];

const narrow: NarrowFn = (req) =>
  narrowGithub(req.path, { githubRepos: SCOPE });

const REPOS = "https://api.github.com/repos";

function item(id: number, repo: string): Record<string, unknown> {
  return { id, repository_url: `${REPOS}/${repo}` };
}

/** `a`, `b`… own the page; `x` is the foreign repo the mission cannot see. */
function searchPage(ids: readonly string[]): unknown {
  return {
    total_count: 400,
    incomplete_results: false,
    items: ids.map((id, index) =>
      item(index, id.startsWith("x") ? "globex/secret" : "acme-corp/product"),
    ),
  };
}

function serveEach(
  pageAt: (index: number) => unknown,
): () => Promise<Response> {
  let index = -1;
  return (): Promise<Response> => {
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(pageAt(index)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

interface SearchBody {
  incomplete_results?: boolean;
  items: { id: number }[];
}

function parsed(body: string | Uint8Array): SearchBody {
  return JSON.parse(bodyText(body)) as SearchBody;
}

function walkRequest(page: number): ReturnType<typeof request> {
  return request({
    path: `/search/issues?q=is%3Aissue&sort=created&order=asc&per_page=1&page=${String(page)}`,
  });
}

describe("pagination refill — REST page numbers", () => {
  it("fills a one-item page instead of answering the empty one", async () => {
    // The agent's own index 3 is a foreign object; the next authorized one is
    // two vendor pages further on.
    const h = harness(
      { narrow },
      serveEach((i) => searchPage([i < 2 ? "x" : "a"])),
    );
    const res = await handle(h.deps, walkRequest(3));

    expect(h.fetchCount()).toBe(3);
    expect(parsed(res.body).items).toHaveLength(1);
    expect(bodyText(res.body)).not.toContain("globex");
  });

  it("asks the vendor for the pages after the one the agent named", async () => {
    const h = harness(
      { narrow },
      serveEach((i) => searchPage([i < 2 ? "x" : "a"])),
    );
    await handle(h.deps, walkRequest(3));

    const pages = h.calls.map(
      (call) => new URL(call.url).searchParams.get("page") ?? "",
    );
    expect(pages).toEqual(["3", "4", "5"]);
    // Nothing else about the request moves: same query, one page further.
    expect(new URL(h.calls[1]?.url ?? "").searchParams.get("per_page")).toBe(
      "1",
    );
    expect(new URL(h.calls[1]?.url ?? "").searchParams.get("sort")).toBe(
      "created",
    );
  });

  it("stops at the call cap and stays honest about the rest", async () => {
    const h = harness(
      { narrow },
      serveEach(() => searchPage(["x"])),
    );
    const res = await handle(h.deps, walkRequest(1));

    expect(h.fetchCount()).toBe(1 + MAX_REFILL_CALLS);
    expect(parsed(res.body).items).toHaveLength(0);
    // GitHub's own way of saying "do not read this as the whole answer".
    expect(parsed(res.body).incomplete_results).toBe(true);
  });

  /**
   * REST publishes no `hasNextPage`, so the end of a collection is a vendor
   * page shorter than `per_page` — and after filtering, the body no longer
   * says how long the vendor's page was. The walk reads it back as
   * `nodes + removed`, which is why a page emptied by the filter still walks
   * on and a page the vendor truly ran out of does not.
   */
  it("does not walk when the vendor's own page came back short", async () => {
    const h = harness(
      { narrow },
      serveEach(() => ({
        total_count: 400,
        incomplete_results: false,
        items: [],
      })),
    );
    await handle(h.deps, walkRequest(1));

    expect(h.fetchCount()).toBe(1);
  });

  it("stops mid-walk on the first page the vendor could not fill", async () => {
    const h = harness(
      { narrow },
      serveEach((i) =>
        i === 0
          ? searchPage(["x"])
          : { total_count: 400, incomplete_results: false, items: [] },
      ),
    );
    const res = await handle(h.deps, walkRequest(1));

    expect(h.fetchCount()).toBe(2);
    expect(parsed(res.body).items).toHaveLength(0);
  });

  /**
   * The oracle itself: two vendors whose foreign objects sit at different
   * indices, with the same authorized object in reach. A reader of the answer
   * cannot tell which index the authorized object came from, so the
   * interleaving is no longer readable off a walk.
   */
  it("answers the same page whatever the interleaving was", async () => {
    const early = harness(
      { narrow },
      serveEach((i) => searchPage([i < 1 ? "x" : "a"])),
    );
    const late = harness(
      { narrow },
      serveEach((i) => searchPage([i < 3 ? "x" : "a"])),
    );

    const one = await handle(early.deps, walkRequest(2));
    const two = await handle(late.deps, walkRequest(2));

    expect(bodyText(one.body)).toBe(bodyText(two.body));
  });
});
