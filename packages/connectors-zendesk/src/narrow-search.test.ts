import { describe, expect, it } from "vitest";
import { narrowZendesk, type ZendeskNarrowResult } from "./narrow";

/**
 * `GET /api/v2/search`, and the one qualifier Zendesk really has.
 *
 * `organization:` is real and takes a name OR a numeric id
 * (`organization:customers`, `organization:22989442`, both published in the
 * Zendesk Support search reference). `organization_id:` is not a qualifier
 * anywhere in that reference. Both are stripped off the agent's query, and the
 * mission's own are forced in — but the qualifier is a NARROWING, not the
 * control: on tickets it is documented as matching "tickets by requesters who
 * are members of the organization", which is a different predicate from
 * `ticket.organization_id`. The filter plan is what decides.
 */

const SCOPE = { zendeskOrganizationIds: ["22989442", "360001"] };
const ONE = { zendeskOrganizationIds: ["22989442"] };

function forwardedQuery(result: ZendeskNarrowResult): string {
  if (result.path === undefined) throw new Error("no forwarded path");
  const search = result.path.slice(result.path.indexOf("?"));
  return new URLSearchParams(search).get("query") ?? "";
}

function search(query: string, scope = SCOPE): ZendeskNarrowResult {
  return narrowZendesk(
    `/api/v2/search?query=${encodeURIComponent(query)}`,
    scope,
  );
}

describe("narrowSearch — forcing the mission's organizations in", () => {
  it("appends one qualifier per organization the mission covers", () => {
    const terms = forwardedQuery(search("type:ticket refund")).split(" ");
    expect(terms).toContain("organization:22989442");
    expect(terms).toContain("organization:360001");
    expect(terms).toContain("type:ticket");
    expect(terms).toContain("refund");
  });

  it("forces them even when the agent asked for nothing", () => {
    const result = narrowZendesk("/api/v2/search", ONE);
    expect(result.decision).toBe("allow");
    expect(forwardedQuery(result)).toBe("organization:22989442");
  });

  it.each([
    ["organization:globex", "organization:globex"],
    ["organization:999", "organization:999"],
    ["organization_id:999", "organization_id:999"],
    ["ORGANIZATION:globex", "ORGANIZATION:globex"],
  ])("drops the agent's own %s", (query, dropped) => {
    const forwarded = forwardedQuery(search(`type:ticket ${query}`));
    expect(forwarded).not.toContain(dropped);
    expect(forwarded).toContain("organization:22989442");
  });

  it("leaves every other qualifier alone", () => {
    const forwarded = forwardedQuery(
      search("type:ticket status:open assignee:sam tags:vip"),
    );
    for (const term of [
      "type:ticket",
      "status:open",
      "assignee:sam",
      "tags:vip",
    ]) {
      expect(forwarded).toContain(term);
    }
  });
});

describe("narrowSearch — a grammar it does not parse", () => {
  /**
   * Zendesk ANDs terms by default, so appending qualifiers to a plain
   * conjunction is sound. A quoted phrase is not a plain conjunction: lifting a
   * qualifier out of one can leave it dangling. Those travel untouched, and the
   * filter — which runs either way — is the only control on that branch.
   */
  it.each([
    'type:ticket "quarterly organization:globex review"',
    "type:ticket (refund OR credit)",
    "type:ticket refund OR organization:globex",
  ])("forwards %s exactly as written, still under a plan", (query) => {
    const result = search(query);
    expect(result.decision).toBe("allow");
    expect(forwardedQuery(result)).toBe(query);
    expect(result.filterPlan?.rules).toHaveLength(1);
  });
});

describe("narrowSearch — the plan that actually decides", () => {
  it("proves organization_id on every result", () => {
    const rule = search("type:ticket").filterPlan?.rules[0];
    expect(rule?.path).toEqual(["results", "*"]);
    expect(rule?.ownerPath).toEqual(["organization_id"]);
    expect(rule?.expectedOwnerIds).toEqual(SCOPE.zendeskOrganizationIds);
    expect(rule?.ownerMatch).toBe("exact");
    expect(rule?.injected).toEqual([]);
  });

  it("walks the result list forward on offset pages", () => {
    const result = narrowZendesk(
      "/api/v2/search?query=type:ticket&page=2&per_page=25",
      SCOPE,
    );
    expect(result.filterPlan?.pagination).toEqual({
      path: [],
      nodes: "results",
      requested: 25,
      cursor: { source: "query-page", param: "page", page: 2, pageSize: 25 },
    });
  });

  it("refuses cursor pagination on search too", () => {
    const result = narrowZendesk(
      "/api/v2/search?query=type:ticket&page[size]=50",
      SCOPE,
    );
    expect(result.decision).toBe("deny");
  });
});

describe("narrowSearch — a query it cannot read as one", () => {
  it("denies two `query` parameters rather than pick one", () => {
    const result = narrowZendesk(
      "/api/v2/search?query=type:ticket&query=organization:globex",
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("more than once");
  });

  it("denies the export endpoint the catalog already refuses", () => {
    const result = narrowZendesk(
      "/api/v2/search/export?query=type:ticket",
      SCOPE,
    );
    expect(result.decision).toBe("deny");
  });
});
