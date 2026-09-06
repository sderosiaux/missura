import type { Operation, OperationStep } from "@missura/core";

/**
 * The Linear operations, beside the route catalog and for the same reason.
 *
 * The plan is the query an agent would write, and nothing more: no customer
 * filter, no id. NARROW injects the mission's customer into `issues` and puts
 * the ownership plan on the answer (`narrow-filter.ts`), exactly as it does
 * for a raw request — so the operation never holds the id, and the step is
 * refused under a mission with no Linear customer the same way a raw query is.
 */

/** Scalars only, so the type walk has nothing to widen or take back. */
const ISSUES_QUERY =
  "query { issues(first: 50) { nodes { id identifier title priority url createdAt } } }";

/** The entity's issues: the customer-filtered `issues` query, page one. */
export const issuesForEntity: Operation = {
  name: "linear.issues.for_entity",
  connector: "linear",
  effect: "read",
  needs: "linear.customer",
  plan(): readonly OperationStep[] {
    return [
      {
        method: "POST",
        path: "/graphql",
        body: JSON.stringify({ query: ISSUES_QUERY }),
      },
    ];
  },
};

export const LINEAR_OPERATIONS: readonly Operation[] = [issuesForEntity];
