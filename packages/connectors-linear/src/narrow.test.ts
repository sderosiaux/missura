import { Kind, parse, print } from "graphql";
import { describe, expect, it } from "vitest";
import { narrowLinear, type LinearNarrowResult } from "./narrow";

const SCOPE = { linearCustomerId: "c_18" };
/**
 * The mission filter, in the shape `@linear/sdk@90` actually declares:
 * `IssueFilter.needs: CustomerNeedCollectionFilter`, whose `some` takes a
 * `CustomerNeedFilter`, whose `customer` takes a `NullableCustomerFilter`,
 * whose `id` takes an `IdComparator`. `IssueFilter` has NO `customer` key —
 * M2 injected one and the vendor rejected every narrowed request.
 */
const OURS = '{needs: {some: {customer: {id: {eq: "c_18"}}}}}';
const OURS_JSON = { needs: { some: { customer: { id: { eq: "c_18" } } } } };

function request(
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
): string {
  const payload: Record<string, unknown> = { query };
  if (variables !== undefined) payload.variables = variables;
  if (operationName !== undefined) payload.operationName = operationName;
  return JSON.stringify(payload);
}

function payloadOf(result: LinearNarrowResult): Record<string, unknown> {
  expect(result.body).toBeTypeOf("string");
  return JSON.parse(result.body ?? "") as Record<string, unknown>;
}

function queryOf(result: LinearNarrowResult): string {
  const query = payloadOf(result).query;
  expect(query).toBeTypeOf("string");
  return String(query);
}

/** Prints the `filter` argument of the first `issues` field — one stable line. */
function filterOf(query: string): string {
  const doc = parse(query);
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const selection of def.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD) continue;
      if (selection.name.value !== "issues") continue;
      const arg = selection.arguments?.find((a) => a.name.value === "filter");
      if (arg === undefined) return "<no filter>";
      return print(arg.value);
    }
  }
  return "<no issues field>";
}

describe("narrowLinear — issues filter injection (inline arguments)", () => {
  it("injects the mission customer filter when the agent sent none", () => {
    const result = narrowLinear(
      request(`query { issues(first: 5) { nodes { id title } } }`),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(filterOf(queryOf(result))).toBe(OURS);
  });

  it("keeps the agent's other filters under an `and`", () => {
    const result = narrowLinear(
      request(
        `query { issues(filter: {assignee: {id: {eq: "u1"}}}) { nodes { id } } }`,
      ),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(filterOf(queryOf(result))).toBe(
      `{and: [{assignee: {id: {eq: "u1"}}}, ${OURS}]}`,
    );
  });

  /**
   * An agent naming ANOTHER customer's needs is not stripped, it is ANDed:
   * `IssueFilter.and` is a conjunction, so whatever the agent wrote can only
   * shrink the result set. What comes back is the issues that are in scope AND
   * also touch globex — issues the mission may already see — and the response
   * filter still removes globex's own needs from them.
   */
  it("cannot be widened by an agent filter naming another customer", () => {
    const result = narrowLinear(
      request(
        `query { issues(filter: {needs: {some: {customer: {id: {eq: "c_globex"}}}}}) { nodes { id } } }`,
      ),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(filterOf(queryOf(result))).toBe(
      `{and: [{needs: {some: {customer: {id: {eq: "c_globex"}}}}}, ${OURS}]}`,
    );
  });

  it("keeps the aliased issues field narrowed too", () => {
    const result = narrowLinear(
      request(`query { mine: issues { nodes { id } } }`),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(queryOf(result)).toContain(OURS);
  });

  it("keeps the operation name and the other request fields", () => {
    const result = narrowLinear(
      request(`query Issues { issues { nodes { id } } }`, { first: 3 }, "Issues"),
      SCOPE,
    );
    const payload = payloadOf(result);
    expect(payload.operationName).toBe("Issues");
    expect(payload.variables).toEqual({ first: 3 });
    expect(() => parse(String(payload.query))).not.toThrow();
  });

  it("denies a filter argument shape it cannot merge", () => {
    const result = narrowLinear(
      request(`query { issues(filter: [1, 2]) { nodes { id } } }`),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("filter");
  });
});

describe("narrowLinear — issues filter injection (variables)", () => {
  const query = `query Issues($filter: IssueFilter) { issues(filter: $filter) { nodes { id } } }`;

  it("merges into the variables when the filter flows through one", () => {
    const result = narrowLinear(
      request(query, { filter: { assignee: { id: { eq: "u1" } } } }, "Issues"),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    const payload = payloadOf(result);
    expect(payload.variables).toEqual({
      filter: { and: [{ assignee: { id: { eq: "u1" } } }, OURS_JSON] },
    });
    expect(queryOf(result)).toContain("filter: $filter");
  });

  it("ANDs a customer filter carried by the variable instead of trusting it", () => {
    const agent = { needs: { some: { customer: { id: { eq: "c_globex" } } } } };
    const result = narrowLinear(request(query, { filter: agent }), SCOPE);
    expect(payloadOf(result).variables).toEqual({
      filter: { and: [agent, OURS_JSON] },
    });
  });

  it("sets the variable when the agent sent no value for it", () => {
    const result = narrowLinear(request(query, { other: 1 }), SCOPE);
    expect(payloadOf(result).variables).toEqual({ other: 1, filter: OURS_JSON });
  });

  it("sets the variable when the request carries no variables at all", () => {
    const result = narrowLinear(request(query), SCOPE);
    expect(payloadOf(result).variables).toEqual({ filter: OURS_JSON });
  });

  it("denies when the filter variable holds a non-object", () => {
    const result = narrowLinear(request(query, { filter: "everything" }), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("filter");
  });

  it("denies when `variables` is not an object", () => {
    const result = narrowLinear(
      JSON.stringify({ query, variables: "nope" }),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("variables");
  });
});
