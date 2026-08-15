import type { FilterPlan, FilterRule } from "@missura/core";
import { describe, expect, it } from "vitest";
import { narrowZendesk, type ZendeskNarrowResult } from "./narrow";

/**
 * The isolation PROPERTIES, written out independently of the implementation.
 *
 * A mission scoped to organization A must not reach organization B's objects by
 * any route the catalog admits: by naming a ticket directly, by listing, by
 * searching with a widening qualifier, or through a comment on a foreign
 * ticket. The connector's own plan is not taken on trust here — the rules are
 * re-evaluated by the small resolver below, which is a second opinion on what
 * a plan MEANS, not a call into the engine that applies it.
 */

const A = "22989442";
const B = "77000111";
const SCOPE = { zendeskOrganizationIds: [A] };

/* ---------------------------------------------------------------- resolver */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A leaf that proves an owner: a non-empty string, or an integer id. */
function leaf(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}

function owners(object: unknown, path: readonly string[]): string[] {
  const [head, ...rest] = path;
  if (head === undefined) {
    const id = leaf(object);
    return id === undefined ? [] : [id];
  }
  if (head === "*") {
    return Array.isArray(object)
      ? object.flatMap((element) => owners(element, rest))
      : [];
  }
  if (!isRecord(object) || !Object.hasOwn(object, head)) return [];
  return owners(object[head], rest);
}

function owned(object: unknown, rule: FilterRule): boolean {
  return owners(object, rule.ownerPath).some((id) =>
    rule.expectedOwnerIds.includes(id),
  );
}

/**
 * What the agent is left with once the plan has been honoured, or `undefined`
 * when a non-nullable single object turned out foreign — i.e. the whole answer
 * fails closed and the agent receives the vendor's own not-found.
 */
function survivors(plan: FilterPlan, body: unknown): unknown[] | undefined {
  const kept: unknown[] = [];
  for (const rule of plan.rules) {
    const list = rule.path[rule.path.length - 1] === "*";
    const container = rule.path.slice(0, list ? -2 : -1);
    const key = rule.path[list ? rule.path.length - 2 : rule.path.length - 1];
    let node: unknown = body;
    for (const segment of container) {
      node = isRecord(node) ? node[segment] : undefined;
    }
    if (!isRecord(node) || key === undefined) continue;
    const target = node[key];
    if (target === undefined || target === null) continue;
    if (list) {
      if (!Array.isArray(target)) return undefined;
      const elements: readonly unknown[] = target;
      kept.push(...elements.filter((element) => owned(element, rule)));
      continue;
    }
    if (!owned(target, rule)) {
      if (!rule.nullable) return undefined;
      continue;
    }
    kept.push(target);
  }
  return kept;
}

function planOf(result: ZendeskNarrowResult): FilterPlan {
  expect(result.decision).toBe("allow");
  if (result.filterPlan === undefined) throw new Error("allowed with no plan");
  return result.filterPlan;
}

/* ------------------------------------------------- reaching a foreign org */

describe("a mission scoped to one organization cannot reach another", () => {
  it("not by naming a foreign ticket directly", () => {
    const plan = planOf(narrowZendesk("/api/v2/tickets/35436", SCOPE));
    expect(survivors(plan, { ticket: { id: 35436, organization_id: B } })).toBe(
      undefined,
    );
  });

  it("not by naming a foreign user directly", () => {
    const plan = planOf(narrowZendesk("/api/v2/users/35436", SCOPE));
    expect(survivors(plan, { user: { id: 35436, organization_id: B } })).toBe(
      undefined,
    );
  });

  it("not by naming the foreign organization itself", () => {
    const result = narrowZendesk(`/api/v2/organizations/${B}`, SCOPE);
    expect(result.decision).toBe("deny");
  });

  it.each([
    `/api/v2/organizations/${B}/tickets`,
    `/api/v2/organizations/${B}/users`,
  ])("not by listing %s", (path) => {
    expect(narrowZendesk(path, SCOPE).decision).toBe("deny");
  });

  it("not by mixing foreign objects into an allowed listing", () => {
    const plan = planOf(
      narrowZendesk(`/api/v2/organizations/${A}/tickets`, SCOPE),
    );
    const kept = survivors(plan, {
      tickets: [
        { id: 1, organization_id: Number(A) },
        { id: 2, organization_id: Number(B) },
        { id: 3, organization_id: null },
        { id: 4 },
      ],
      count: 4,
      next_page: `https://acme.zendesk.com/api/v2/organizations/${A}/tickets?page=2`,
    });
    expect(kept).toEqual([{ id: 1, organization_id: Number(A) }]);
  });

  it.each([
    `type:ticket organization:${B}`,
    `organization_id:${B}`,
    `type:ticket ORGANIZATION:${B}`,
  ])("not by widening the search query with %s", (query) => {
    const result = narrowZendesk(
      `/api/v2/search?query=${encodeURIComponent(query)}`,
      SCOPE,
    );
    const forwarded = result.path ?? "";
    expect(decodeURIComponent(forwarded)).not.toContain(B);
    expect(decodeURIComponent(forwarded)).toContain(`organization:${A}`);
  });

  it("not through a search answer that came back mixed", () => {
    const plan = planOf(narrowZendesk("/api/v2/search?query=refund", SCOPE));
    const kept = survivors(plan, {
      results: [
        { id: 1, result_type: "ticket", organization_id: Number(A) },
        { id: 2, result_type: "ticket", organization_id: Number(B) },
        { id: 3, result_type: "user", organization_id: Number(B) },
        // An organization result publishes `id`, never `organization_id`: its
        // owner does not resolve, so it is foreign.
        { id: Number(A), result_type: "organization", name: "acme" },
        { id: 5, result_type: "group", name: "Level 2" },
      ],
      count: 5,
    });
    expect(kept).toEqual([
      { id: 1, result_type: "ticket", organization_id: Number(A) },
    ]);
  });

  /**
   * Even a query missura forwards verbatim — one carrying grammar it does not
   * parse — is decided by the plan, not by the qualifier.
   */
  it("not through a query missura forwards untouched", () => {
    const plan = planOf(
      narrowZendesk(
        `/api/v2/search?query=${encodeURIComponent(`refund OR organization:${B}`)}`,
        SCOPE,
      ),
    );
    expect(
      survivors(plan, { results: [{ id: 9, organization_id: Number(B) }] }),
    ).toEqual([]);
  });

  it("not by a comment on a foreign ticket", () => {
    const result = narrowZendesk("/api/v2/tickets/35436/comments", SCOPE);
    expect(result.decision).toBe("deny");
  });
});

/* --------------------------------------------------- an unresolvable owner */

describe("an owner that cannot be resolved is foreign", () => {
  const single = (body: unknown): unknown[] | undefined =>
    survivors(planOf(narrowZendesk("/api/v2/tickets/1", SCOPE)), body);

  it.each([
    ["null", { ticket: { id: 1, organization_id: null } }],
    ["absent", { ticket: { id: 1 } }],
    ["a boolean", { ticket: { id: 1, organization_id: true } }],
    ["an empty string", { ticket: { id: 1, organization_id: "" } }],
    ["a float", { ticket: { id: 1, organization_id: 22989442.5 } }],
    ["nested elsewhere", { ticket: { id: 1, organization: { id: A } } }],
    ["an array", { ticket: { id: 1, organization_id: [A] } }],
    ["not an object at all", { ticket: 1 }],
  ])("fails the answer closed when the discriminator is %s", (_, body) => {
    expect(single(body)).toBe(undefined);
  });

  it("keeps the object only when the discriminator really matches", () => {
    expect(single({ ticket: { id: 1, organization_id: Number(A) } })).toEqual([
      { id: 1, organization_id: Number(A) },
    ]);
  });

  /**
   * A KNOWN AND DELIBERATE CONSEQUENCE. Zendesk documents `user.organization_id`
   * as "the id of the user's organization — if the user has more than one
   * organization membership, the id of the user's DEFAULT organization". So a
   * user who belongs to the mission's organization but defaults to another is
   * dropped, even when reached through `/api/v2/organizations/{id}/users`.
   *
   * That is the fail-closed direction and it is the one we want: the
   * alternative is trusting the endpoint's own scope for an object whose
   * published discriminator disagrees with it, which is exactly "pretending to
   * filter what we do not see". Resolving the real answer needs
   * `/api/v2/organization_memberships`, which the catalog refuses by name.
   */
  it("drops a multi-organization user whose default organization is foreign", () => {
    const plan = planOf(
      narrowZendesk(`/api/v2/organizations/${A}/users`, SCOPE),
    );
    expect(
      survivors(plan, {
        users: [
          { id: 1, organization_id: Number(A) },
          { id: 2, organization_id: Number(B) },
        ],
      }),
    ).toEqual([{ id: 1, organization_id: Number(A) }]);
  });
});

/* ------------------------------------------------------ refused by name */

/**
 * Every family the product decision refuses, at the connector's front door.
 * The catalog spec pins the reasons; this pins that NARROW cannot be talked
 * into any of them either, whatever the mission covers.
 */
const NEVER: readonly string[] = [
  "/api/v2/incremental/tickets?start_time=0",
  "/api/v2/incremental/tickets/cursor",
  "/api/v2/incremental/ticket_events?start_time=0",
  "/api/v2/incremental/users/cursor",
  "/api/v2/incremental/organizations?start_time=0",
  "/api/v2/job_statuses",
  "/api/v2/job_statuses/8b726e606741012ffc2d782bcb5adc00",
  "/api/v2/tickets/show_many?ids=1,2",
  "/api/v2/users/show_many?ids=1,2",
  "/api/v2/organizations/show_many?ids=1,2",
  "/api/v2/users/create_many",
  "/api/v2/tickets/destroy_many?ids=1,2",
  "/api/v2/search/export?query=type:ticket",
  "/api/v2/exports/tickets",
  "/api/v2/account/settings",
  "/api/v2/oauth/tokens",
  "/api/v2/api_tokens",
  "/api/v2/users/me",
  "/api/v2/users/1/identities",
  "/api/v2/organization_memberships",
  "/api/v2/group_memberships",
  "/api/v2/custom_roles",
  "/api/v2/triggers",
  "/api/v2/audit_logs",
  "/api/v2/attachments/498483",
  "/api/v2/uploads/6bk3gqumlu9tv4n",
];

describe("no mission reaches a refused family", () => {
  it.each(NEVER)("denies %s", (path) => {
    const result = narrowZendesk(path, SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.filterPlan).toBeUndefined();
    expect(result.path).toBeUndefined();
  });

  it("denies them under a mission covering many organizations too", () => {
    for (const path of NEVER) {
      const wide = narrowZendesk(path, {
        zendeskOrganizationIds: [A, B, "1", "2"],
      });
      expect(wide.decision).toBe("deny");
    }
  });
});

/* ---------------------------------------------------- spelling the target */

describe("no spelling of a foreign target reaches the vendor", () => {
  it.each([
    `/api/v2/organizations/${A}/../${B}/tickets`,
    `/api/v2/organizations/${A}/..%2f${B}/tickets`,
    `/api/v2/organizations/${A}/..%252f${B}%2ftickets`,
    `/api/v2/organizations/${A}\\..\\${B}\\tickets`,
    `/api/v2/organizations/${B}.json/tickets`,
    `/api/v2/organizations/${B}/tickets.json`,
  ])("denies %s", (path) => {
    expect(narrowZendesk(path, SCOPE).decision).toBe("deny");
  });

  it("does not read a non-decimal id as the organization it resembles", () => {
    // Leading zero, full-width and Arabic-Indic digits: none of these is the
    // integer Zendesk stores, so none of them is in scope.
    for (const id of [`0${A}`, "٢٢٩٨٩٤٤٢", "２２９８９４４２"]) {
      expect(
        narrowZendesk(`/api/v2/organizations/${id}/tickets`, SCOPE).decision,
      ).toBe("deny");
    }
  });

  it("refuses everything under a mission with no Zendesk organization", () => {
    for (const path of [
      `/api/v2/organizations/${A}`,
      `/api/v2/organizations/${A}/tickets`,
      "/api/v2/tickets/1",
      "/api/v2/users/1",
      "/api/v2/search?query=refund",
    ]) {
      const result = narrowZendesk(path, { zendeskOrganizationIds: [] });
      expect(result.decision).toBe("deny");
      expect(result.filterPlan).toBeUndefined();
    }
  });
});
