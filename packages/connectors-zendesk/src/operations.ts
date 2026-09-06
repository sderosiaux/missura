import {
  OperationParameterError,
  type Operation,
  type OperationStep,
  type ResolvedScope,
} from "@missura/core";

/**
 * The Zendesk operations, beside the route catalog and for the same reason:
 * this package knows what Zendesk can serve, so it says what missura can do
 * with it.
 *
 * A plan names TARGETS, taken from the resolved scope; it decides nothing. The
 * step it emits is the request an agent would have written, and the pipeline
 * runs it through this connector's catalog and NARROW like any other. That is
 * what keeps an operation from carrying a second copy of the scoping rule:
 * `organizationCollection` in `narrow.ts` still proves the organization is the
 * mission's, and still puts the ownership plan on the answer.
 */

/**
 * The entity's tickets: one `organizations.tickets.list` per organization the
 * mission resolves to. The organization-scoped route is chosen over the
 * account-wide one because it is the only ticket list the catalog admits.
 */
export const ticketsForEntity: Operation = {
  name: "zendesk.tickets.for_entity",
  connector: "zendesk",
  effect: "read",
  needs: "zendesk.organization",
  plan(scope: ResolvedScope): readonly OperationStep[] {
    return (scope.zendeskOrganizationIds ?? []).map((id) => ({
      method: "GET",
      path: `/api/v2/organizations/${id}/tickets.json`,
      body: "",
    }));
  },
};

function ticketParam(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new OperationParameterError("ticket", "must be a positive integer ticket id");
  }
  return value;
}

function bodyParam(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OperationParameterError("body", "must be a non-empty string");
  }
  return value;
}

/**
 * THE EGRESS (M10): a PUBLIC comment on a ticket, which Zendesk emails to the
 * requester. The write lands inside the mission's organization; the email
 * leaves it — so this is `egress`, not `append`, and a human approves it
 * even when the ticket is in scope. The plan takes the ticket from the agent
 * and decides nothing: a ticket id says nothing about its organization, so
 * NARROW proves the ticket first, through the ticket itself, before the
 * write leaves (`narrow-write.ts`). `public: true` is pinned here, not
 * taken from the agent: a private note would be a different operation.
 */
export const ticketReply: Operation = {
  name: "zendesk.ticket.reply",
  connector: "zendesk",
  effect: "egress",
  needs: "zendesk.organization",
  plan(
    _scope: ResolvedScope,
    params: Readonly<Record<string, unknown>>,
  ): readonly OperationStep[] {
    const ticket = ticketParam(params.ticket);
    const body = bodyParam(params.body);
    return [
      {
        method: "PUT",
        path: `/api/v2/tickets/${String(ticket)}`,
        body: JSON.stringify({ ticket: { comment: { body, public: true } } }),
      },
    ];
  },
};

export const ZENDESK_OPERATIONS: readonly Operation[] = [ticketsForEntity, ticketReply];
