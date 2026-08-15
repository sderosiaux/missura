import type { ZendeskTargets } from "./assume-zendesk-shape";
import type { OperationSpec } from "./classify";
import type { Operation } from "./exchange";

/**
 * HALF B, Zendesk — every catalogued operation, and every family the catalog
 * refuses by name.
 *
 * `request` is a TEMPLATE, not the call that runs: `{org}`, `{ticket}`,
 * `{user}` stay unbound in the spec because the spec is what the coverage
 * manifest carries into the repository, and a bound one would commit a
 * customer's organization id and a ticket number. The bound spelling lives in
 * `path`, is used once, and never reaches a file.
 *
 * `narrowed` and `filtered` are CLAIMS — what the connector says it does. The
 * run does not trust them: `upstream` records what actually travelled and the
 * shape diff records what actually came back. They are in the manifest so a
 * reader can see the claim and the observation side by side.
 */

/** `narrow-plan.ts` strips these four from every Zendesk answer. */
const VENDOR_POSITIONS: readonly string[] = [
  "next_page",
  "previous_page",
  "links",
  "meta",
];

/** Two, not one: a filtered list has to be able to come back SHORTER than asked. */
const PAGE = 2;

function spec(over: Partial<OperationSpec> & { operation: string; request: string }): OperationSpec {
  return {
    vendor: "zendesk",
    narrowed: [],
    filtered: [],
    refused: [],
    strips: VENDOR_POSITIONS,
    ...over,
  };
}

function get(specification: OperationSpec, path: string): Operation {
  return { spec: specification, method: "GET", path };
}

/** A refusal is never issued to the vendor — see `Operation.skipDirect`. */
function refused(specification: OperationSpec, path: string): Operation {
  return { spec: specification, method: "GET", path, skipDirect: true };
}

const SEARCH_QUERY = "type:ticket organization:";

function searchPath(organizationId: string): string {
  const params = new URLSearchParams({
    query: `${SEARCH_QUERY}${organizationId}`,
    per_page: String(PAGE),
  });
  return `/api/v2/search.json?${params.toString()}`;
}

function catalogued(targets: ZendeskTargets): Operation[] {
  const org = targets.organizationId;
  const out: Operation[] = [
    get(
      spec({
        operation: "organizations.get",
        request: "GET /api/v2/organizations/{org}.json",
        narrowed: ["refused unless {org} is an organization the mission covers"],
        filtered: ["the organization proves itself by its own `id`"],
      }),
      `/api/v2/organizations/${org}.json`,
    ),
    get(
      spec({
        operation: "organizations.tickets.list",
        request: "GET /api/v2/organizations/{org}/tickets.json?per_page=2",
        narrowed: [
          "the organization is native to the path — the account-wide `/api/v2/tickets` is refused in its favour",
          "`page[…]` cursor pagination is refused",
        ],
        filtered: [
          "every ticket whose `organization_id` is not the mission's is dropped, and the count beside the list with it",
          "`next_page` / `previous_page` are taken back — they are positions in the UNFILTERED list",
        ],
      }),
      `/api/v2/organizations/${org}/tickets.json?per_page=${String(PAGE)}`,
    ),
    get(
      spec({
        operation: "organizations.users.list",
        request:
          "GET /api/v2/organizations/{org}/users.json?per_page=2&include=organizations",
        narrowed: ["`include=` sideloads are never forwarded — a second object graph no rule describes"],
        filtered: [
          "every user whose `organization_id` is not the mission's is dropped",
          "the sideloaded `organizations` graph the vendor would have attached is absent",
        ],
        // The sideload the connector refuses to forward: the vendor's own
        // answer carries it, ours must not, and that is a declared removal
        // rather than a field that went missing.
        strips: [...VENDOR_POSITIONS, "organizations"],
      }),
      `/api/v2/organizations/${org}/users.json?per_page=${String(PAGE)}&include=organizations`,
    ),
    get(
      spec({
        operation: "search.list",
        request: "GET /api/v2/search.json?query=type:ticket organization:{org}&per_page=2",
        narrowed: [
          "the agent's own `organization:` / `organization_id:` terms are stripped and the mission's are forced in",
        ],
        filtered: [
          "every result whose `organization_id` is not the mission's is dropped — including organizations and groups, which publish none",
        ],
      }),
      searchPath(org),
    ),
  ];

  const ticket = targets.ticketId;
  if (ticket !== undefined) {
    out.push(
      get(
        spec({
          operation: "tickets.get",
          request: "GET /api/v2/tickets/{ticket}.json",
          narrowed: ["nothing: a ticket id says nothing about an organization before the call"],
          filtered: [
            "a ticket outside the mission fails the whole response closed into Zendesk's own not-found",
          ],
        }),
        `/api/v2/tickets/${ticket}.json`,
      ),
      get(
        spec({
          operation: "tickets.comments.list",
          request: "GET /api/v2/tickets/{ticket}/comments.json?per_page=2",
          narrowed: [
            "the OWNING TICKET is proven first, by a probe of /api/v2/tickets/{ticket} — a comment names no organization",
          ],
          filtered: [
            "`attachments` and `uploads` are taken back: a `content_url` is a second hop missura does not proxy",
          ],
          strips: [
            ...VENDOR_POSITIONS,
            "comments.*.attachments",
            "comments.*.uploads",
          ],
        }),
        `/api/v2/tickets/${ticket}/comments.json?per_page=${String(PAGE)}`,
      ),
    );
  }

  const user = targets.userId;
  if (user !== undefined) {
    out.push(
      get(
        spec({
          operation: "users.get",
          request: "GET /api/v2/users/{user}.json",
          narrowed: ["nothing: a user id says nothing about an organization before the call"],
          filtered: ["a user outside the mission fails closed into Zendesk's own not-found"],
        }),
        `/api/v2/users/${user}.json`,
      ),
    );
  }
  return out;
}

/**
 * The refusals, each aimed at the exact path the refusal table names. None is
 * issued to the vendor: an account-wide listing or an incremental export run
 * "just to see" is the very call the catalog exists to prevent.
 */
function refusals(targets: ZendeskTargets): Operation[] {
  const org = targets.organizationId;
  return [
    refused(
      spec({
        operation: "refused.unscoped_listing",
        request: "GET /api/v2/tickets.json",
        refused: [
          "an account-wide listing is never allowed — Zendesk publishes organization-scoped forms of it",
        ],
      }),
      "/api/v2/tickets.json",
    ),
    refused(
      spec({
        operation: "refused.incremental_exports",
        request: "GET /api/v2/incremental/tickets.json?start_time=0",
        refused: [
          "incremental exports stream the whole account and take no organization parameter — there is nothing to narrow",
        ],
      }),
      "/api/v2/incremental/tickets.json?start_time=0",
    ),
    refused(
      spec({
        operation: "refused.bulk",
        request: "GET /api/v2/organizations/show_many.json?ids={org}",
        refused: ["bulk and batch endpoints answer for many objects at once across the account"],
      }),
      `/api/v2/organizations/show_many.json?ids=${org}`,
    ),
    refused(
      spec({
        operation: "refused.admin",
        request: "GET /api/v2/users/me.json",
        refused: ["administration and identity endpoints carry no organization to scope by"],
      }),
      "/api/v2/users/me.json",
    ),
    refused(
      spec({
        operation: "refused.attachments",
        request: "GET /api/v2/attachments/{id}.json",
        refused: [
          "an attachment's `content_url` points at a host outside this connection, which missura does not proxy because it cannot filter it",
        ],
      }),
      "/api/v2/attachments/1.json",
    ),
  ];
}

export function zendeskOperations(targets: ZendeskTargets): Operation[] {
  return [...catalogued(targets), ...refusals(targets)];
}
