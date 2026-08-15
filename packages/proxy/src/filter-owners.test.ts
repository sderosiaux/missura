import type { FilterPlan, FilterRule } from "@missura/core";
import { describe, expect, it } from "vitest";
import { applyFilterPlan } from "./filter";

/**
 * One rule, several acceptable owners: a mission holds a SET of entities (a
 * GitHub mission holds several repos), so an object is ours when its owner is
 * any of them. One rule per owner on the same path cannot express that — each
 * would drop what the others keep.
 */
const ITEMS: FilterRule = {
  path: ["items", "*"],
  type: "SearchResult",
  ownerPath: ["repository_url"],
  expectedOwnerIds: [
    "https://api.github.com/repos/acme-corp/product",
    "https://api.github.com/repos/acme-corp/infra",
  ],
  ownerMatch: "exact",
  injected: [],
  nullable: false,
};

function plan(rules: readonly FilterRule[]): FilterPlan {
  return { rules, strip: [] };
}

function items(...urls: string[]): string {
  return JSON.stringify({
    items: urls.map((repository_url, index) => ({
      id: index,
      repository_url,
    })),
  });
}

function keptUrls(body: string): unknown {
  const parsed = JSON.parse(body) as { items: { repository_url: string }[] };
  return parsed.items.map((item) => item.repository_url);
}

describe("filter engine — a rule with several acceptable owners", () => {
  it("keeps objects owned by ANY of them", () => {
    const out = applyFilterPlan(
      plan([ITEMS]),
      items(
        "https://api.github.com/repos/acme-corp/product",
        "https://api.github.com/repos/globex/secret",
        "https://api.github.com/repos/acme-corp/infra",
      ),
    );

    expect(out.ok).toBe(true);
    expect(out.objectsRemoved).toBe(1);
    expect(keptUrls(out.body)).toEqual([
      "https://api.github.com/repos/acme-corp/product",
      "https://api.github.com/repos/acme-corp/infra",
    ]);
  });

  it("treats an owner in none of them as foreign", () => {
    const out = applyFilterPlan(
      plan([ITEMS]),
      items("https://api.github.com/repos/acme-corp/productX"),
    );

    expect(keptUrls(out.body)).toEqual([]);
  });

  it("owns nothing when the set is empty — an unresolved scope keeps no object", () => {
    const out = applyFilterPlan(
      plan([{ ...ITEMS, expectedOwnerIds: [] }]),
      items("https://api.github.com/repos/acme-corp/product"),
    );

    expect(keptUrls(out.body)).toEqual([]);
    expect(out.objectsRemoved).toBe(1);
  });

  it("nulls a foreign single object against the whole set", () => {
    const single: FilterRule = {
      ...ITEMS,
      path: ["item"],
      nullable: true,
    };
    const body = JSON.stringify({
      item: { repository_url: "https://api.github.com/repos/globex/secret" },
    });
    const out = applyFilterPlan(plan([single]), body);

    expect(JSON.parse(out.body)).toEqual({ item: null });
  });
});

describe("filter engine — owner comparison", () => {
  it("rejects a different spelling under `exact`", () => {
    const out = applyFilterPlan(
      plan([ITEMS]),
      items("https://api.github.com/repos/Acme-Corp/Product"),
    );

    expect(keptUrls(out.body)).toEqual([]);
  });

  it("accepts a different ASCII spelling under `ascii-case-insensitive`", () => {
    const out = applyFilterPlan(
      plan([{ ...ITEMS, ownerMatch: "ascii-case-insensitive" }]),
      items("https://api.github.com/repos/Acme-Corp/PRODUCT"),
    );

    expect(keptUrls(out.body)).toEqual([
      "https://api.github.com/repos/Acme-Corp/PRODUCT",
    ]);
  });

  /**
   * `K` (U+212A KELVIN SIGN) lowercases to `k` under Unicode case folding, so
   * `String.toLowerCase()` would call a repo named `Kafka` the mission's
   * `kafka` — a foreign object kept by the very check meant to drop it. ASCII
   * folding is the whole point of the mode's name.
   */
  it("does not fold a non-ASCII lookalike into a mission owner", () => {
    const out = applyFilterPlan(
      plan([
        {
          ...ITEMS,
          expectedOwnerIds: ["https://api.github.com/repos/acme-corp/kafka"],
          ownerMatch: "ascii-case-insensitive",
        },
      ]),
      items("https://api.github.com/repos/acme-corp/Kafka"),
    );

    expect(keptUrls(out.body)).toEqual([]);
  });

  it("compares the mission's own spelling ASCII-insensitively too", () => {
    const out = applyFilterPlan(
      plan([
        {
          ...ITEMS,
          expectedOwnerIds: ["https://api.github.com/repos/Acme-Corp/Product"],
          ownerMatch: "ascii-case-insensitive",
        },
      ]),
      items("https://api.github.com/repos/acme-corp/product"),
    );

    expect(keptUrls(out.body)).toEqual([
      "https://api.github.com/repos/acme-corp/product",
    ]);
  });
});
