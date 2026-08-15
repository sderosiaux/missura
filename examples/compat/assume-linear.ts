import type { Exchange } from "./classify";
import { assumption, checked, type Assumption, type LinearCredential } from "./harness";
import { call, pace } from "./http";
import {
  firstGraphqlError,
  hasGraphqlErrors,
  introspectionQuery,
  readIntrospection,
  type IntrospectedType,
} from "./introspect";
import { readPinnedSchema, schemaAssumptions } from "./linear-schema";
import { announced } from "./upstream";

/**
 * HALF A, Linear — the trio whose absence caused the M2 disaster, then the
 * pinned schema against reality.
 *
 * M2 shipped `filter: { customer: { id: { eq: … } } }` and a post-check on
 * `issue.customer.id`. `Issue` has no `customer` field and `IssueFilter` has no
 * `customer` key: the vendor rejected every narrowed request, and nobody knew
 * because `demo:m2` was never run against a real workspace. Nothing here is
 * read off our own source — the vendor answers, and the answer is the evidence.
 */

export const LINEAR_URL = "https://api.linear.app/graphql";
const NARROW_FILTER_FILE = "packages/connectors-linear/src/narrow-filter.ts";
const CLASSIFICATION_FILE =
  "packages/connectors-linear/src/schema/classification.ts";
/** Conservative: Linear's budget is generous, this suite's need for it is not. */
const PACE_MS = 400;

/** The input types `narrow-filter.ts` walks down to reach `eq`. */
const FILTER_CHAIN: readonly (readonly [string, string, string])[] = [
  ["IssueFilter", "needs", "CustomerNeedCollectionFilter"],
  ["CustomerNeedCollectionFilter", "some", "CustomerNeedFilter"],
  ["CustomerNeedFilter", "customer", "NullableCustomerFilter"],
  ["NullableCustomerFilter", "id", "IdComparator"],
  ["IdComparator", "eq", "ID"],
];

export function linearBody(query: string): string {
  return JSON.stringify({ query });
}

export async function linearCall(
  credential: LinearCredential,
  label: string,
  query: string,
): Promise<Exchange> {
  await pace(PACE_MS);
  return call(
    announced(label, {
      method: "POST",
      url: LINEAR_URL,
      headers: {
        authorization: credential.apiKey,
        "content-type": "application/json",
      },
      body: linearBody(query),
    }),
  );
}

/** True when the answer is a 200 carrying no `errors` — the vendor accepted it. */
function accepted(exchange: Exchange): boolean {
  return exchange.status === 200 && !hasGraphqlErrors(exchange.body);
}

function refusal(exchange: Exchange): string {
  const message = firstGraphqlError(exchange.body);
  return message ?? `status ${String(exchange.status)}, no readable GraphQL error`;
}

/**
 * `Issue` has NO `customer` field. Introspection answers it outright; with
 * introspection off, a query that selects the field answers it too — by being
 * refused, which is the same fact seen from the other side.
 */
async function noCustomerField(
  credential: LinearCredential,
  live: Map<string, IntrospectedType> | undefined,
): Promise<Assumption> {
  const base = {
    id: "linear.issue.no-customer-field",
    vendor: "linear" as const,
    claim:
      "`Issue` exposes no `customer` field — the customer link is not on the issue",
    encodedIn: NARROW_FILTER_FILE,
  };
  const issue = live?.get("Issue");
  if (issue !== undefined && issue.fields.size > 0) {
    const present = issue.fields.has("customer");
    return assumption(
      base,
      present ? "BROKEN" : "HOLDS",
      present
        ? `introspection: type Issue DOES declare \`customer\` — the connector routes around a field that exists`
        : `introspection: type Issue declares ${String(issue.fields.size)} fields, none named \`customer\` (\`needs\` is present)`,
    );
  }
  const probe = await linearCall(
    credential,
    "linear · probe Issue.customer",
    "query { issues(first: 1) { nodes { customer { id } } } }",
  );
  if (accepted(probe)) {
    return assumption(
      base,
      "BROKEN",
      "probe: `issues { nodes { customer { id } } }` was ACCEPTED — the field exists",
    );
  }
  return assumption(
    base,
    "HOLDS",
    `probe (introspection unavailable): selecting Issue.customer was refused — ${refusal(probe)}`,
  );
}

/** `Issue.needs` → `CustomerNeed.customer`: the path the connector proves by. */
async function needsPath(
  credential: LinearCredential,
  live: Map<string, IntrospectedType> | undefined,
): Promise<Assumption> {
  const base = {
    id: "linear.issue.needs-customer",
    vendor: "linear" as const,
    claim:
      "`Issue.needs` exists and each `CustomerNeed` carries `customer` — the only path from an issue to a customer",
    encodedIn: CLASSIFICATION_FILE,
  };
  const issue = live?.get("Issue");
  const need = live?.get("CustomerNeed");
  if (issue !== undefined && need !== undefined && issue.fields.size > 0) {
    const needs = issue.fields.get("needs");
    const customer = need.fields.get("customer");
    if (needs === undefined || customer === undefined) {
      return assumption(
        base,
        "BROKEN",
        `introspection: Issue.needs is ${needs === undefined ? "GONE" : "present"}, CustomerNeed.customer is ${customer === undefined ? "GONE" : "present"}`,
      );
    }
    return assumption(
      base,
      "HOLDS",
      `introspection: Issue.needs → ${needs.name ?? "?"}, CustomerNeed.customer → ${customer.name ?? "?"} (${customer.nullable ? "nullable" : "non-null"})`,
    );
  }
  const probe = await linearCall(
    credential,
    "linear · probe Issue.needs → CustomerNeed.customer",
    "query { issues(first: 1) { nodes { needs { nodes { customer { id } } } } } }",
  );
  return assumption(
    base,
    accepted(probe) ? "HOLDS" : "BROKEN",
    accepted(probe)
      ? "probe (introspection unavailable): `issues { nodes { needs { nodes { customer { id } } } } }` was accepted"
      : `probe (introspection unavailable): the path was refused — ${refusal(probe)}`,
  );
}

/** Which link of the input chain introspection says is missing, if any. */
function brokenChainLink(
  inputs: Map<string, IntrospectedType> | undefined,
): string | undefined {
  if (inputs === undefined) return undefined;
  for (const [type, field, expected] of FILTER_CHAIN) {
    const entry = inputs.get(type);
    if (entry === undefined || entry.inputFields.size === 0) {
      return `input type ${type} is absent from the live schema`;
    }
    const found = entry.inputFields.get(field);
    if (found === undefined) return `${type} has no \`${field}\` input field`;
    if (found.name !== expected) {
      return `${type}.${field} is \`${found.name ?? "?"}\`, not \`${expected}\``;
    }
  }
  return undefined;
}

/**
 * The filter itself, exactly as `narrow-filter.ts` builds it — inline literal
 * and all. Acceptance by the vendor is the claim, so nothing but a live call
 * can settle it: introspection of the chain is corroboration, and it is what
 * names the broken link when the call fails.
 */
async function filterAccepted(
  credential: LinearCredential,
  inputs: Map<string, IntrospectedType> | undefined,
): Promise<Assumption> {
  const base = {
    id: "linear.filter.needs-some-customer-id-eq",
    vendor: "linear" as const,
    claim:
      "`IssueFilter.needs.some.customer.id.eq` is accepted by the vendor — the native narrow M2 got wrong",
    encodedIn: NARROW_FILTER_FILE,
  };
  const literal = JSON.stringify(credential.customerId);
  const probe = await linearCall(
    credential,
    "linear · probe the injected mission filter",
    `query { issues(first: 1, filter: { needs: { some: { customer: { id: { eq: ${literal} } } } } }) { nodes { id } } }`,
  );
  const chain = brokenChainLink(inputs);
  if (accepted(probe)) {
    return assumption(
      base,
      "HOLDS",
      chain === undefined
        ? "the vendor accepted the injected filter, and introspection resolves the whole input chain IssueFilter.needs → some → customer → id → eq"
        : `the vendor accepted the injected filter, though introspection disagrees about the chain: ${chain}`,
    );
  }
  return assumption(
    base,
    "BROKEN",
    `the vendor REFUSED the injected filter — ${refusal(probe)}${chain === undefined ? "" : `; introspection: ${chain}`}`,
  );
}

/**
 * Every Linear assumption, in reading order: the trio first, because it is the
 * one a reader came for, then the artifact sweep.
 */
export async function linearAssumptions(
  credential: LinearCredential,
): Promise<Assumption[]> {
  const pinned = readPinnedSchema();
  const outputs = await linearCall(
    credential,
    "linear · introspect the pinned types",
    introspectionQuery([...pinned.keys()], "fields"),
  );
  const live = readIntrospection(outputs.body);
  const inputs = readIntrospection(
    (
      await linearCall(
        credential,
        "linear · introspect the filter input chain",
        introspectionQuery(
          FILTER_CHAIN.map(([type]) => type),
          "inputFields",
        ),
      )
    ).body,
  );

  const results: Assumption[] = [
    await noCustomerField(credential, live),
    await needsPath(credential, live),
    await filterAccepted(credential, inputs),
  ];
  if (live === undefined) {
    results.push(
      assumption(
        {
          id: "linear.schema.pinned-artifact",
          vendor: "linear",
          claim: "the pinned schema still describes the live schema",
          encodedIn: "packages/connectors-linear/src/schema/schema.json",
        },
        "UNVERIFIABLE",
        `introspection is unavailable on this workspace (${refusal(outputs)}), and a per-field probe of ${String(pinned.size)} types is not a call budget this suite will spend on someone's tenant`,
      ),
    );
    return results;
  }
  results.push(...schemaAssumptions(pinned, live, "introspection"));
  return results;
}

/** Wraps the whole section so a network failure reads as UNVERIFIABLE, not BROKEN. */
export function linearSection(
  credential: LinearCredential,
): Promise<Assumption[]> {
  return linearAssumptions(credential).catch(async (err: unknown) => [
    await checked(
      {
        id: "linear.section",
        vendor: "linear",
        claim: "the Linear assumption checks could run at all",
        encodedIn: NARROW_FILTER_FILE,
      },
      () => Promise.reject(err instanceof Error ? err : new Error(String(err))),
    ),
  ]);
}
