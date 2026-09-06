import type { Operation, OperationStep, ResolvedScope } from "@missura/core";

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

export const ZENDESK_OPERATIONS: readonly Operation[] = [ticketsForEntity];
