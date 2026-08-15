import { linearCall } from "./assume-linear";
import type { OperationSpec } from "./classify";
import type { Operation } from "./exchange";
import type { LinearCredential } from "./harness";

/**
 * HALF B, Linear — the narrowable root fields, and two refusals.
 *
 * One choice here needs stating because it looks like cheating and is the
 * opposite. The `issues` operation sends the mission's own customer filter
 * ALREADY WRITTEN, so the vendor and missura are asked about the same set of
 * issues. Without it the vendor answers with the workspace's newest issues and
 * missura with the customer's, and the shape diff would then be comparing two
 * different objects — every optional field that happens to be set on one and
 * not the other would read as a type change, and the report would fill with
 * findings about nothing.
 *
 * What that costs: this half no longer observes that the filter NARROWS. What
 * pays for it: half A proves the vendor accepts that exact filter
 * (`linear.filter.needs-some-customer-id-eq`), the narrowing itself is observed
 * on the wire as a rewritten document, and `examples/m3-proof` is where an
 * unfiltered SDK read is shown coming back scoped.
 */

const GRAPHQL_PATH = "/graphql";

/** Scalars and a metadata connection — nothing whose presence varies per issue. */
const ISSUE_FIELDS = "id identifier title createdAt url";

export interface LinearTargets {
  customerId: string;
  /** An issue linked to that customer, if it has one. */
  issueId?: string;
}

function body(query: string): string {
  return JSON.stringify({ query });
}

function spec(
  over: Partial<OperationSpec> & { operation: string; request: string },
): OperationSpec {
  return {
    vendor: "linear",
    narrowed: [],
    filtered: [],
    refused: [],
    strips: [],
    ...over,
  };
}

function post(specification: OperationSpec, query: string): Operation {
  return {
    spec: specification,
    method: "POST",
    path: GRAPHQL_PATH,
    body: body(query),
  };
}

/** The filter `narrow-filter.ts` injects, written out as an agent would. */
export function missionFilter(customerId: string): string {
  return `filter: { needs: { some: { customer: { id: { eq: ${JSON.stringify(customerId)} } } } } }`;
}

function issuesQuery(customerId: string, first: number): string {
  return `query { issues(first: ${String(first)}, ${missionFilter(customerId)}) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage } } }`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first issue id the customer's own issues came back with, or nothing. */
export async function discoverLinearTargets(
  credential: LinearCredential,
): Promise<LinearTargets> {
  const exchange = await linearCall(
    credential,
    "linear · discover one issue of the mission's customer",
    issuesQuery(credential.customerId, 1),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(exchange.body);
  } catch {
    return { customerId: credential.customerId };
  }
  const data = isRecord(parsed) ? parsed.data : undefined;
  const issues = isRecord(data) ? data.issues : undefined;
  const nodes = isRecord(issues) ? issues.nodes : undefined;
  const first: unknown = Array.isArray(nodes) ? nodes[0] : undefined;
  const id = isRecord(first) && typeof first.id === "string" ? first.id : undefined;
  return {
    customerId: credential.customerId,
    ...(id === undefined ? {} : { issueId: id }),
  };
}

export function linearOperations(targets: LinearTargets): Operation[] {
  const out: Operation[] = [
    post(
      spec({
        operation: "viewer",
        request: "POST /graphql — query { viewer { id name } }",
        narrowed: ["nothing: the caller's own identity is metadata, owned by no customer"],
      }),
      "query { viewer { id name } }",
    ),
    post(
      spec({
        operation: "issues",
        request:
          "POST /graphql — query { issues(first: 2, filter: {needs:{some:{customer:{id:{eq:{customer}}}}}}) { nodes { id identifier title createdAt url } pageInfo { hasNextPage } } }",
        narrowed: [
          "`needs.some.customer.id.eq` is ANDed into the filter — the agent's own filter is kept, never widened",
        ],
        filtered: [
          "`needs { nodes { customer { id } } }` is added to prove ownership and taken back before the agent sees it",
          "issues whose needs name no mission customer are dropped",
        ],
      }),
      issuesQuery(targets.customerId, 2),
    ),
  ];

  const issue = targets.issueId;
  if (issue !== undefined) {
    out.push(
      post(
        spec({
          operation: "issue",
          request: "POST /graphql — query { issue(id: {issue}) { id identifier title } }",
          narrowed: [
            "nothing: an issue id says nothing about a customer before the call, so the answer is proven instead",
          ],
          filtered: [
            "an issue whose needs name no mission customer comes back as a GraphQL error, not as data",
          ],
        }),
        `query { issue(id: ${JSON.stringify(issue)}) { id identifier title } }`,
      ),
    );
  }

  out.push(
    {
      spec: spec({
        operation: "refused.uncatalogued-root",
        request: "POST /graphql — query { teams { nodes { id } } }",
        refused: ["`teams` is not in the Linear read catalog — deny by default"],
      }),
      method: "POST",
      path: GRAPHQL_PATH,
      body: body("query { teams { nodes { id } } }"),
      skipDirect: true,
    },
    {
      spec: spec({
        operation: "refused.customers",
        request: "POST /graphql — query { customers(first: 1) { nodes { id } } }",
        refused: [
          "`customers` is catalogued but cannot be narrowed: a filtered connection still carries the vendor's `pageInfo`, so an agent could count the workspace's customers without receiving one — `customer(id:)` is the narrowed read",
        ],
      }),
      method: "POST",
      path: GRAPHQL_PATH,
      body: body("query { customers(first: 1) { nodes { id } } }"),
      skipDirect: true,
    },
    {
      spec: spec({
        operation: "refused.introspection",
        request: "POST /graphql — query { __schema { types { name } } }",
        refused: ["introspection fields are refused by name — the catalog serves data, not the schema"],
      }),
      method: "POST",
      path: GRAPHQL_PATH,
      body: body("query { __schema { types { name } } }"),
      skipDirect: true,
    },
  );
  return out;
}
