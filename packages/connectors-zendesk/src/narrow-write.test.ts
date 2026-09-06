import { describe, expect, it } from "vitest";
import { narrowZendesk } from "./narrow";
import { NO_ORGANIZATION_IN_SCOPE } from "./narrow-result";

/**
 * NARROW on the one write (M10): a ticket update, reachable only as the
 * inner call of `zendesk.ticket.reply`. A ticket's id says nothing about its
 * organization, and a write cannot be filtered after it landed — so the
 * proof runs BEFORE, through the ticket itself, exactly as a ticket's
 * comments are proven for a read. A foreign ticket and a ticket that never
 * existed refuse the same way, and the write never leaves for either.
 */

const SCOPE = { zendeskOrganizationIds: ["4200", "4300"] };
const VIA = { operation: "zendesk.ticket.reply" };
const PUT = { method: "PUT", via: VIA };

describe("narrowZendesk — PUT on a ticket", () => {
  it("allows the write behind a proof of the ticket, and proves the answer too", () => {
    const result = narrowZendesk("/api/v2/tickets/35436", SCOPE, PUT);
    expect(result.decision).toBe("allow");
    expect(result.path).toBe("/api/v2/tickets/35436");
    expect(result.denyShape).toBe("zendesk404");
    expect(result.parentProof).toEqual({
      key: "ticket:35436",
      probe: { method: "GET", path: "/api/v2/tickets/35436", body: "" },
      ownerPath: ["ticket", "organization_id"],
    });
    expect(result.missionOwnerIds).toEqual(SCOPE.zendeskOrganizationIds);
    expect(result.missionScopeSize).toBe(2);
    // The updated ticket comes back with its organization: proven like a read.
    expect(result.filterPlan?.rules.map((rule) => rule.path)).toEqual([["ticket"]]);
  });

  it("decides on the canonical target: the `.json` spelling and a query string travel stripped", () => {
    const result = narrowZendesk("/api/v2/tickets/35436.json?include=users", SCOPE, PUT);
    expect(result.decision).toBe("allow");
    expect(result.path).toBe("/api/v2/tickets/35436");
  });

  it("refuses the PUT with no operation behind it — the raw path never writes", () => {
    const result = narrowZendesk("/api/v2/tickets/35436", SCOPE, { method: "PUT" });
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("zendesk404");
    expect(result.denialCode).toBe("missura_operation_not_in_catalog");
  });

  it("refuses every other write shape under the operation, not-found shaped", () => {
    for (const path of [
      "/api/v2/tickets",
      "/api/v2/tickets/35436/comments",
      "/api/v2/tickets/me",
      "/api/v2/organizations/4200",
      "/api/v2/users/35436",
      "/api/v2/tickets/35436/..%2f..%2fincremental/tickets",
    ]) {
      const result = narrowZendesk(path, SCOPE, PUT);
      expect(result.decision, path).toBe("deny");
      expect(result.denyShape, path).toBe("zendesk404");
    }
    expect(narrowZendesk("/api/v2/tickets/35436", SCOPE, { method: "DELETE", via: VIA }).decision).toBe(
      "deny",
    );
  });

  it("refuses under a mission that resolves to no organization, before any proof", () => {
    const result = narrowZendesk("/api/v2/tickets/35436", { zendeskOrganizationIds: [] }, PUT);
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe(NO_ORGANIZATION_IN_SCOPE);
    expect(result.parentProof).toBeUndefined();
  });
});
