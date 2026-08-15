import type { FilterPlan, FilterRule } from "@missura/core";
import { describe, expect, it } from "vitest";
import { narrowZendesk, type ZendeskNarrowResult } from "./narrow";

/**
 * NARROW against a mission that resolves to Zendesk organization ids.
 *
 * Two controls, in this order (SPEC §2.2, §2.3, §4.4.2): the organization scope
 * is injected NATIVELY where Zendesk supports it — an organization-scoped
 * endpoint, or the `organization:` search qualifier — and a `FilterPlan` proves
 * ownership on whatever comes back. The second is not a fallback for the first;
 * it runs on every allowed request, including the ones the path already scoped.
 */

const SCOPE = { zendeskOrganizationIds: ["22989442", "360001"] };
const ONE = { zendeskOrganizationIds: ["22989442"] };
const NONE = { zendeskOrganizationIds: [] };

function plan(result: ZendeskNarrowResult): FilterPlan {
  if (result.filterPlan === undefined) throw new Error("no filter plan");
  return result.filterPlan;
}

function onlyRule(result: ZendeskNarrowResult): FilterRule {
  const rules = plan(result).rules;
  expect(rules).toHaveLength(1);
  const rule = rules[0];
  if (rule === undefined) throw new Error("no rule");
  return rule;
}

describe("narrowZendesk — a mission with no Zendesk organization", () => {
  it.each([
    "/api/v2/organizations/22989442",
    "/api/v2/organizations/22989442/tickets",
    "/api/v2/organizations/22989442/users",
    "/api/v2/tickets/35436",
    "/api/v2/users/35436",
    "/api/v2/search?query=type:ticket",
  ])("denies %s outright", (path) => {
    const result = narrowZendesk(path, NONE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("organization");
    expect(result.missionScopeSize).toBe(0);
    expect(result.path).toBeUndefined();
    expect(result.filterPlan).toBeUndefined();
  });
});

describe("narrowZendesk — an organization by id", () => {
  it("allows one the mission covers, proving the organization's own id", () => {
    const result = narrowZendesk("/api/v2/organizations/22989442", SCOPE);
    expect(result.decision).toBe("allow");
    const rule = onlyRule(result);
    expect(rule.path).toEqual(["organization"]);
    expect(rule.ownerPath).toEqual(["id"]);
    expect(rule.expectedOwnerIds).toEqual(SCOPE.zendeskOrganizationIds);
    expect(rule.ownerMatch).toBe("exact");
    expect(rule.nullable).toBe(false);
    expect(rule.injected).toEqual([]);
  });

  it("refuses one it does not, without saying which", () => {
    const result = narrowZendesk("/api/v2/organizations/999", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("zendesk404");
    expect(result.missionScopeSize).toBe(2);
    expect(JSON.stringify(result)).not.toContain("999");
  });
});

describe("narrowZendesk — an organization's tickets and users", () => {
  it.each([
    ["/api/v2/organizations/22989442/tickets", "tickets"],
    ["/api/v2/organizations/22989442/users", "users"],
  ])("scopes %s natively and still proves what comes back", (path, key) => {
    const result = narrowZendesk(path, SCOPE);
    expect(result.decision).toBe("allow");
    const rule = onlyRule(result);
    expect(rule.path).toEqual([key, "*"]);
    expect(rule.ownerPath).toEqual(["organization_id"]);
    expect(rule.expectedOwnerIds).toEqual(SCOPE.zendeskOrganizationIds);
  });

  it.each([
    "/api/v2/organizations/999/tickets",
    "/api/v2/organizations/999/users",
  ])("refuses %s for an organization outside the mission", (path) => {
    expect(narrowZendesk(path, SCOPE).decision).toBe("deny");
  });
});

describe("narrowZendesk — an object named by id", () => {
  /**
   * A ticket id says nothing about an organization, so the request cannot be
   * refused before the call — the plan proves it on the way back, and a foreign
   * ticket fails the whole response closed (`nullable: false`) into Zendesk's
   * own not-found. Same shape as a ticket that never existed.
   */
  it.each([
    ["/api/v2/tickets/35436", "ticket"],
    ["/api/v2/users/35436", "user"],
  ])("lets %s run and proves the answer", (path, key) => {
    const result = narrowZendesk(path, SCOPE);
    expect(result.decision).toBe("allow");
    expect(result.denyShape).toBe("zendesk404");
    const rule = onlyRule(result);
    expect(rule.path).toEqual([key]);
    expect(rule.ownerPath).toEqual(["organization_id"]);
    expect(rule.nullable).toBe(false);
  });
});

describe("narrowZendesk — a ticket's comments", () => {
  /**
   * VERIFIED ABSENCE, not an omission. A Zendesk ticket comment carries
   * `attachments, audit_id, author_id, body, created_at, html_body, id,
   * metadata, plain_body, public, type, uploads, via` — no organization, and no
   * ticket either. The endpoint's only sideload is `include=users`
   * (developer.zendesk.com, Ticket Comments), and `comments` is not among the
   * ticket sideloads, so no single call returns both the comments and the
   * ticket's organization.
   *
   * Which leaves resolving the ticket first — a second hop this connector does
   * not make — or forwarding a read whose owner cannot be resolved. An object
   * whose owner cannot be resolved is foreign, so the refusal is the same rule
   * every other object here is judged by.
   */
  it("refuses the listing rather than forward what it cannot prove", () => {
    const result = narrowZendesk("/api/v2/tickets/35436/comments", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("zendesk404");
    expect(result.reason).toContain("organization");
    expect(result.filterPlan).toBeUndefined();
  });

  it("refuses it identically whichever ticket is named", () => {
    const mine = narrowZendesk("/api/v2/tickets/1/comments", SCOPE);
    const foreign = narrowZendesk("/api/v2/tickets/2/comments", SCOPE);
    expect(mine).toEqual(foreign);
  });
});

describe("narrowZendesk — what the request may carry", () => {
  it("strips a sideload the agent asked for", () => {
    const result = narrowZendesk(
      "/api/v2/organizations/22989442/tickets?include=users,organizations&per_page=50",
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(result.path).not.toContain("include");
    expect(result.path).toContain("per_page=50");
  });

  /**
   * Cursor pagination is Zendesk's modern shape (`page[size]`, `page[after]`),
   * and its position is computed over the UNFILTERED result set — following it
   * walks a list whose sizes we changed. `FilterPlan`'s pagination contract has
   * no variant for a query-string cursor, so there is nothing to swap it for
   * either. Refusing says so; forwarding it and stripping the cursor would hand
   * the agent one page and no way to say why there is no second.
   */
  it("refuses cursor pagination and says what to use instead", () => {
    for (const param of [
      "page[size]=100",
      "page[after]=xyz",
      "page[before]=x",
    ]) {
      const result = narrowZendesk(
        `/api/v2/organizations/22989442/tickets?${param}`,
        SCOPE,
      );
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("per_page");
    }
  });

  it("walks offset pagination forward on the agent's own page number", () => {
    const result = narrowZendesk(
      "/api/v2/organizations/22989442/tickets?page=3&per_page=50",
      SCOPE,
    );
    const pagination = plan(result).pagination;
    expect(pagination).toEqual({
      path: [],
      nodes: "tickets",
      requested: 50,
      cursor: { source: "query-page", param: "page", page: 3, pageSize: 50 },
    });
  });

  it("clamps a page size past Zendesk's own ceiling", () => {
    const result = narrowZendesk(
      "/api/v2/organizations/22989442/tickets?per_page=500",
      SCOPE,
    );
    expect(plan(result).pagination?.requested).toBe(100);
  });

  /**
   * `next_page` / `previous_page` are absolute vendor URLs computed over the
   * unfiltered set, exactly like the GitHub `link` header the proxy drops
   * whenever a plan applies. `meta` / `links` are their cursor-pagination
   * spelling, stripped defensively even though the request that would produce
   * them is refused.
   */
  it("takes back the vendor's own pagination positions", () => {
    const stripped = plan(
      narrowZendesk("/api/v2/organizations/22989442/tickets", SCOPE),
    ).strip;
    expect(stripped).toContainEqual(["next_page"]);
    expect(stripped).toContainEqual(["previous_page"]);
    expect(stripped).toContainEqual(["links"]);
    expect(stripped).toContainEqual(["meta"]);
  });
});

describe("narrowZendesk — the target it decides on", () => {
  it("refuses a path it cannot decode rather than guess at it", () => {
    const result = narrowZendesk("/api/v2/tickets/%E0%A4%A", ONE);
    expect(result.decision).toBe("deny");
    expect(result.denialCode).toBe("missura_invalid_target");
  });

  /**
   * Zendesk decodes `%2F` as a separator, so deciding on the raw segments would
   * read `/api/v2/organizations/1/..%2f..%2fincremental/tickets` as a path
   * inside an allowed organization. The decision is taken on the collapsed
   * form, and the collapsed form is what would travel.
   */
  it("decides on the collapsed path, not the agent's spelling of it", () => {
    const result = narrowZendesk(
      "/api/v2/organizations/22989442/..%2f..%2fincremental/tickets",
      SCOPE,
    );
    expect(result.decision).toBe("deny");
  });

  it("carries the mission's size on every refusal, and never its members", () => {
    const result = narrowZendesk("/api/v2/organizations/999", SCOPE);
    expect(result.missionScopeSize).toBe(2);
    expect(JSON.stringify(result)).not.toContain("22989442");
  });
});
