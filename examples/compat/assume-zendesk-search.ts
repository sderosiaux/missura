import { assumption, type Assumption, type ZendeskCredential } from "./harness";
import { relation, searchCount, TINY_PAGE, zendeskCall } from "./zendesk-api";

/**
 * HALF A, Zendesk — the two search-grammar facts the connector author could NOT
 * establish from the documentation, and which `narrow-search.ts` had to assume.
 *
 * Both are load-bearing. The first decides whether stripping `organization_id:`
 * is a courtesy or a correction; the second decides whether a mission covering
 * several organizations searches all of them or none of them. Neither is a
 * safety property — the `FilterPlan` proves `organization_id` on every result
 * either way — but a connector that quietly returns nothing is broken, and the
 * only place that shows up is here.
 */

export const NARROW_SEARCH_FILE =
  "packages/connectors-zendesk/src/narrow-search.ts";

function searchPath(query: string): string {
  const params = new URLSearchParams({
    query,
    per_page: String(TINY_PAGE),
  });
  return `/api/v2/search.json?${params.toString()}`;
}

async function count(
  credential: ZendeskCredential,
  label: string,
  query: string,
): Promise<number | undefined> {
  const exchange = await zendeskCall(credential, label, searchPath(query));
  return exchange.status === 200 ? searchCount(exchange.body) : undefined;
}

/**
 * Is `organization_id:` a search qualifier?
 *
 * The discriminator is three counts on the SAME account: the documented
 * qualifier, the undocumented spelling, and the unqualified search. If the
 * undocumented spelling were a qualifier it would count what the documented one
 * counts; read as free text it counts tickets whose text happens to contain it,
 * which on any real tenant is a different number — usually none.
 *
 * The unqualified count is what makes the answer honest: on an account where
 * ONE organization owns every ticket, "same count" proves nothing at all, and
 * this returns UNVERIFIABLE instead of a verdict it did not earn.
 */
export async function organizationIdQualifier(
  credential: ZendeskCredential,
  organizationId: string,
): Promise<Assumption> {
  const base = {
    id: "zendesk.search.organization_id-not-a-qualifier",
    vendor: "zendesk" as const,
    claim:
      "`organization_id:` is NOT a Zendesk search qualifier — a query carrying one is read as free text, which is why the connector strips it instead of forwarding it",
    encodedIn: NARROW_SEARCH_FILE,
  };
  const qualified = await count(
    credential,
    "zendesk · search with the documented `organization:` qualifier",
    `type:ticket organization:${organizationId}`,
  );
  const undocumented = await count(
    credential,
    "zendesk · search with the undocumented `organization_id:` spelling",
    `type:ticket organization_id:${organizationId}`,
  );
  const unqualified = await count(
    credential,
    "zendesk · search with no organization at all",
    "type:ticket",
  );
  if (
    qualified === undefined ||
    undocumented === undefined ||
    unqualified === undefined
  ) {
    return assumption(
      base,
      "UNVERIFIABLE",
      "at least one of the three searches did not answer 200 with a `count`",
    );
  }
  if (qualified === unqualified) {
    return assumption(
      base,
      "UNVERIFIABLE",
      "`organization:<id>` and the unqualified search return the same count on this account — one organization owns everything here, so no comparison can separate a qualifier from free text",
    );
  }
  if (undocumented === qualified) {
    return assumption(
      base,
      "BROKEN",
      "`organization_id:<id>` returns the SAME count as `organization:<id>`, and the unqualified search returns a different one — the vendor is treating `organization_id:` as a qualifier, so stripping it narrows a query the vendor would have narrowed itself",
    );
  }
  return assumption(
    base,
    "HOLDS",
    `\`organization_id:<id>\` returns ${relation(undocumented, qualified)} results than \`organization:<id>\`, which returns ${relation(qualified, unqualified)} than the unqualified search — the undocumented spelling does not select the organization`,
  );
}

/**
 * Do repeated `organization:` terms OR, or AND?
 *
 * `narrow-search.ts` appends one qualifier per mission organization and reads
 * the reference as saying a repeated property keyword ORs with itself. If it
 * ANDs, a two-organization mission searches for a ticket belonging to both,
 * which no ticket does — the agent gets an empty page and no error.
 *
 * A ticket belongs to exactly one organization, so the two readings are
 * separable by arithmetic: under OR the pair counts A + B, under AND it counts
 * nothing. Anything else is a third behaviour and gets reported as itself.
 */
export async function repeatedOrganizationTerms(
  credential: ZendeskCredential,
  first: string,
  second: string | undefined,
): Promise<Assumption> {
  const base = {
    id: "zendesk.search.repeated-organization-ors",
    vendor: "zendesk" as const,
    claim:
      "repeated `organization:` terms OR with each other — a mission covering several organizations searches all of them",
    encodedIn: NARROW_SEARCH_FILE,
  };
  if (second === undefined) {
    return assumption(
      base,
      "UNVERIFIABLE",
      "this run has one organization in scope; set ZENDESK_ORGANIZATION_ID_2 to a second one — with a single id, ORing and ANDing are the same query",
    );
  }
  const a = await count(
    credential,
    "zendesk · search organization A",
    `type:ticket organization:${first}`,
  );
  const b = await count(
    credential,
    "zendesk · search organization B",
    `type:ticket organization:${second}`,
  );
  const both = await count(
    credential,
    "zendesk · search organization A and B, as the connector spells it",
    `type:ticket organization:${first} organization:${second}`,
  );
  if (a === undefined || b === undefined || both === undefined) {
    return assumption(
      base,
      "UNVERIFIABLE",
      "at least one of the three searches did not answer 200 with a `count`",
    );
  }
  if (a === 0 || b === 0) {
    return assumption(
      base,
      "UNVERIFIABLE",
      `one of the two organizations has no tickets (A is ${a === 0 ? "empty" : "non-empty"}, B is ${b === 0 ? "empty" : "non-empty"}), so the pair cannot distinguish OR from AND`,
    );
  }
  if (both === a + b) {
    return assumption(
      base,
      "HOLDS",
      "the two-qualifier search returns exactly the sum of the two single-qualifier searches — repeated `organization:` terms OR",
    );
  }
  if (both === 0) {
    return assumption(
      base,
      "BROKEN",
      "the two-qualifier search returns NOTHING while each single-qualifier search returns results — repeated `organization:` terms AND, so a multi-organization mission searches for a ticket that cannot exist",
    );
  }
  return assumption(
    base,
    "BROKEN",
    `the two-qualifier search returns neither the sum nor nothing: it is ${relation(both, a + b)} the sum of the two singles — the grammar is neither of the two readings the connector considered`,
  );
}
