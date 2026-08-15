import {
  organizationIdQualifier,
  repeatedOrganizationTerms,
} from "./assume-zendesk-search";
import { zendeskErrorAssumptions } from "./assume-zendesk-errors";
import {
  zendeskShapeAssumptions,
  type ZendeskTargets,
} from "./assume-zendesk-shape";
import { assumption, type Assumption, type ZendeskCredential } from "./harness";
import { firstId, TINY_PAGE, zendeskCall } from "./zendesk-api";

/**
 * HALF A, Zendesk — the whole section, and the two ids the rest of the run aims
 * with.
 *
 * Discovery is its own step and its own two calls rather than a value borrowed
 * from a check: a check that also had to produce an id would have to succeed
 * for the id to exist, and half B would then be skipped by a half-A failure it
 * has nothing to do with.
 */

export type { ZendeskTargets } from "./assume-zendesk-shape";

const NO_ORGANIZATION = {
  id: "zendesk.scope.organization",
  vendor: "zendesk" as const,
  claim: "this run names at least one organization to scope by",
  encodedIn: "packages/connectors-zendesk/src/narrow.ts",
};

/**
 * A ticket and a user of the mission's organization, or neither. Both are used
 * only to AIM later calls; neither ever reaches the report, where an id is a
 * customer's ticket number.
 */
export async function discoverZendeskTargets(
  credential: ZendeskCredential,
  organizationId: string,
): Promise<ZendeskTargets> {
  const tickets = await zendeskCall(
    credential,
    "zendesk · discover one ticket of the organization",
    `/api/v2/organizations/${organizationId}/tickets.json?per_page=${String(TINY_PAGE)}`,
  );
  const users = await zendeskCall(
    credential,
    "zendesk · discover one user of the organization",
    `/api/v2/organizations/${organizationId}/users.json?per_page=${String(TINY_PAGE)}`,
  );
  const ticketId = firstId(tickets.body, "tickets");
  const userId = firstId(users.body, "users");
  return {
    organizationId,
    ...(ticketId === undefined ? {} : { ticketId }),
    ...(userId === undefined ? {} : { userId }),
  };
}

export async function zendeskAssumptions(
  credential: ZendeskCredential,
  targets: ZendeskTargets,
): Promise<Assumption[]> {
  const [first, second] = credential.organizationIds;
  if (first === undefined) {
    return [
      assumption(
        NO_ORGANIZATION,
        "UNVERIFIABLE",
        "set ZENDESK_ORGANIZATION_ID to an organization of your account — a mission that names none reaches nothing, so there is nothing to check",
      ),
    ];
  }
  return [
    await organizationIdQualifier(credential, first),
    await repeatedOrganizationTerms(credential, first, second),
    ...(await zendeskErrorAssumptions(credential, first)),
    ...(await zendeskShapeAssumptions(credential, targets)),
  ];
}
