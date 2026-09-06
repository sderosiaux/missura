import type { ResolvedScope } from "@missura/core";
import { describe, expect, it } from "vitest";
import { decideZendesk } from "./catalog";
import { narrowZendesk } from "./narrow";
import { ZENDESK_OPERATIONS, ticketsForEntity } from "./operations";

/**
 * An operation is a plan of requests an agent COULD have sent itself. The
 * proof is that each step, handed to this connector's own catalog and NARROW
 * with the same scope, is allowed and travels unchanged — so the operation
 * carries no scoping of its own and can reach nothing a raw call could not.
 */

const SCOPE: ResolvedScope = {
  githubRepos: [],
  zendeskOrganizationIds: ["4200", "4300"],
};

describe("zendesk.tickets.for_entity", () => {
  it("is the one Zendesk read, and says what it needs", () => {
    expect(ZENDESK_OPERATIONS.map((op) => op.name)).toEqual([
      "zendesk.tickets.for_entity",
    ]);
    expect(ticketsForEntity).toMatchObject({
      connector: "zendesk",
      effect: "read",
      needs: "zendesk.organization",
    });
  });

  it("plans one organization-scoped ticket list per organization in the scope", () => {
    expect(ticketsForEntity.plan(SCOPE, {})).toEqual([
      { method: "GET", path: "/api/v2/organizations/4200/tickets.json", body: "" },
      { method: "GET", path: "/api/v2/organizations/4300/tickets.json", body: "" },
    ]);
  });

  it("plans nothing for a scope with no organization — never the account-wide list", () => {
    expect(ticketsForEntity.plan({ githubRepos: [] }, {})).toEqual([]);
  });

  it("plans steps the connector's own catalog and NARROW allow as they are", () => {
    for (const step of ticketsForEntity.plan(SCOPE, {})) {
      const verdict = decideZendesk(step.method, step.path);
      expect(verdict.decision).toBe("allow");
      expect(verdict.operation).toBe("organizations.tickets.list");
      const narrowed = narrowZendesk(step.path, {
        zendeskOrganizationIds: [...(SCOPE.zendeskOrganizationIds ?? [])],
      });
      expect(narrowed.decision).toBe("allow");
      expect(narrowed.filterPlan).toBeDefined();
    }
  });

  /**
   * The scope decides, not the plan: a step planned for one mission and run
   * under another is refused by NARROW exactly like the raw request would be.
   */
  it("plans steps NARROW refuses under a mission that does not cover them", () => {
    const [first] = ticketsForEntity.plan(SCOPE, {});
    if (first === undefined) throw new Error("no step planned");
    const foreign = narrowZendesk(first.path, {
      zendeskOrganizationIds: ["9999"],
    });
    expect(foreign.decision).toBe("deny");
  });
});
