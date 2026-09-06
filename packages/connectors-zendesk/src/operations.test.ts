import { OperationParameterError, type ResolvedScope } from "@missura/core";
import { describe, expect, it } from "vitest";
import { decideZendesk } from "./catalog";
import { narrowZendesk } from "./narrow";
import { ZENDESK_OPERATIONS, ticketReply, ticketsForEntity } from "./operations";

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

/**
 * THE EGRESS (M10): a public reply on a ticket. Zendesk emails the requester
 * on a public comment, so the write stays inside the mission's organization
 * and its destination does not — `effect: "egress"`, never `append`. The
 * plan builds one PUT from the agent's own parameters and decides nothing:
 * whether the ticket is the mission's is NARROW's, proven on the step
 * through the ticket itself before the write leaves.
 */
describe("zendesk.ticket.reply", () => {
  const VIA = { operation: "zendesk.ticket.reply" };
  const PARAMS = { ticket: 35436, body: "Thanks — we are on it." };
  const ZENDESK_SCOPE = { zendeskOrganizationIds: ["4200", "4300"] };

  it("is an egress that needs an organization in the mission", () => {
    expect(ZENDESK_OPERATIONS.map((op) => op.name)).toEqual([
      "zendesk.tickets.for_entity",
      "zendesk.ticket.reply",
    ]);
    expect(ticketReply).toMatchObject({
      name: "zendesk.ticket.reply",
      connector: "zendesk",
      effect: "egress",
      needs: "zendesk.organization",
    });
  });

  it("plans exactly one PUT on the ticket, as a PUBLIC comment in Zendesk's own shape", () => {
    expect(ticketReply.plan(SCOPE, PARAMS)).toEqual([
      {
        method: "PUT",
        path: "/api/v2/tickets/35436",
        body: '{"ticket":{"comment":{"body":"Thanks — we are on it.","public":true}}}',
      },
    ]);
  });

  it("plans a step the catalog and NARROW allow AS AN INNER CALL, behind a proof of the ticket", () => {
    const [step] = ticketReply.plan(SCOPE, PARAMS);
    if (step === undefined) throw new Error("no step planned");
    expect(decideZendesk(step.method, step.path, VIA)).toMatchObject({
      decision: "allow",
      operation: "tickets.update",
      action: "egress",
    });
    const narrowed = narrowZendesk(step.path, ZENDESK_SCOPE, { method: step.method, via: VIA });
    expect(narrowed.decision).toBe("allow");
    expect(narrowed.path).toBe(step.path);
    expect(narrowed.parentProof?.key).toBe("ticket:35436");
    expect(decideZendesk(step.method, step.path).decision).toBe("deny");
    expect(narrowZendesk(step.path, ZENDESK_SCOPE, { method: step.method }).decision).toBe("deny");
  });

  it("refuses a parameter it cannot build a vendor request from, naming the parameter", () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ body: "x" }, "ticket"],
      [{ ...PARAMS, ticket: "35436" }, "ticket"],
      [{ ...PARAMS, ticket: 0 }, "ticket"],
      [{ ...PARAMS, ticket: 1.5 }, "ticket"],
      [{ ticket: 35436 }, "body"],
      [{ ...PARAMS, body: "   " }, "body"],
      [{ ...PARAMS, body: 7 }, "body"],
    ];
    for (const [params, parameter] of bad) {
      let thrown: unknown;
      try {
        ticketReply.plan(SCOPE, params);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(OperationParameterError);
      expect((thrown as OperationParameterError).parameter).toBe(parameter);
    }
  });
});
