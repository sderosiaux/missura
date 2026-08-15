import { assumption, type Assumption, type ZendeskCredential } from "./harness";
import {
  bodyKeys,
  listLength,
  paginationStyle,
  TINY_PAGE,
  zendeskCall,
  type PaginationStyle,
} from "./zendesk-api";

/**
 * HALF A, Zendesk — the endpoints the catalog names, the page sizes the plan
 * assumes, and the pagination style each catalogued collection answers with.
 *
 * `narrow-plan.ts` hard-codes a maximum and a default page of 100 and can only
 * express OFFSET pagination; `catalog.ts` allows exactly two organization-scoped
 * collections because the account-wide forms are refused in their favour. All
 * of that is documentation until an endpoint answers.
 */

const CATALOG_FILE = "packages/connectors-zendesk/src/catalog.ts";
const PLAN_FILE = "packages/connectors-zendesk/src/narrow-plan.ts";

/** What `MAX_PER_PAGE` in `narrow-plan.ts` says, restated so a drift is visible. */
const PINNED_MAX_PER_PAGE = 100;
/** One more than the cap: enough to observe it, and 101 objects rather than 200. */
const OVER_CAP = PINNED_MAX_PER_PAGE + 1;

export interface ZendeskTargets {
  organizationId: string;
  /** A ticket of that organization, discovered — absent when it has none. */
  ticketId?: string;
  /** A user of that organization, discovered the same way. */
  userId?: string;
}

const ACCOUNT_TICKETS = "/api/v2/search.json?query=type%3Aticket";

function endpointAssumption(
  id: string,
  operation: string,
  path: string,
  key: string,
  status: number,
  length: number | undefined,
  keys: readonly string[],
): Assumption {
  const base = {
    id,
    vendor: "zendesk" as const,
    claim: `\`${operation}\` exists: GET ${path} answers 200 with a root \`${key}\` array`,
    encodedIn: CATALOG_FILE,
  };
  if (status !== 200) {
    return assumption(
      base,
      status === 404 ? "BROKEN" : "UNVERIFIABLE",
      `the endpoint answered ${String(status)} — top-level keys {${keys.join(", ")}}`,
    );
  }
  if (length === undefined) {
    return assumption(
      base,
      "BROKEN",
      `the endpoint answered 200 but carries no root \`${key}\` array — keys {${keys.join(", ")}}`,
    );
  }
  return assumption(
    base,
    "HOLDS",
    `200 with a root \`${key}\` array (asked ${String(TINY_PAGE)}, top-level keys {${keys.join(", ")}})`,
  );
}

function styleAssumption(
  operation: string,
  path: string,
  style: PaginationStyle,
  keys: readonly string[],
): Assumption {
  const base = {
    id: `zendesk.pagination.style.${operation}`,
    vendor: "zendesk" as const,
    claim: `\`${operation}\` answers with OFFSET pagination — the only style a FilterPlan can express, and what the connector strips on the way out`,
    encodedIn: PLAN_FILE,
  };
  if (style === "offset") {
    return assumption(base, "HOLDS", `GET ${path} answered offset-style (keys {${keys.join(", ")}})`);
  }
  if (style === "neither") {
    return assumption(
      base,
      "UNVERIFIABLE",
      `GET ${path} carried no pagination position at all — a single short page proves nothing about the style (keys {${keys.join(", ")}})`,
    );
  }
  return assumption(
    base,
    "BROKEN",
    `GET ${path} answered ${style}-style — the plan strips \`next_page\`/\`previous_page\`/\`links\`/\`meta\`, and a walk it cannot express is a page the agent gets short (keys {${keys.join(", ")}})`,
  );
}

/** The two organization-scoped collections, plus their pagination style. */
async function collections(
  credential: ZendeskCredential,
  targets: ZendeskTargets,
): Promise<Assumption[]> {
  const out: Assumption[] = [];
  const scoped: readonly (readonly [string, string, string])[] = [
    [
      "organizations.tickets.list",
      `/api/v2/organizations/${targets.organizationId}/tickets.json?per_page=${String(TINY_PAGE)}`,
      "tickets",
    ],
    [
      "organizations.users.list",
      `/api/v2/organizations/${targets.organizationId}/users.json?per_page=${String(TINY_PAGE)}`,
      "users",
    ],
  ];
  for (const [operation, path, key] of scoped) {
    const exchange = await zendeskCall(credential, `zendesk · ${operation}`, path);
    const keys = bodyKeys(exchange.body);
    out.push(
      endpointAssumption(
        `zendesk.endpoint.${operation}`,
        operation,
        path.split("?")[0] ?? path,
        key,
        exchange.status,
        listLength(exchange.body, key),
        keys,
      ),
    );
    out.push(
      styleAssumption(operation, path.split("?")[0] ?? path, paginationStyle(exchange.body), keys),
    );
  }

  const ticketId = targets.ticketId;
  if (ticketId !== undefined) {
    const path = `/api/v2/tickets/${ticketId}/comments.json?per_page=${String(TINY_PAGE)}`;
    const exchange = await zendeskCall(
      credential,
      "zendesk · tickets.comments.list",
      path,
    );
    out.push(
      styleAssumption(
        "tickets.comments.list",
        "/api/v2/tickets/{id}/comments",
        paginationStyle(exchange.body),
        bodyKeys(exchange.body),
      ),
    );
  }
  return out;
}

/**
 * The page ceiling and the page default, observed in that order because the
 * first answers whether the second can be observed at all: a default of 100 is
 * indistinguishable from "this account has 60 tickets" until something has come
 * back full.
 */
async function pageSizes(credential: ZendeskCredential): Promise<Assumption[]> {
  const capBase = {
    id: "zendesk.pagination.max-per-page",
    vendor: "zendesk" as const,
    claim: `a page holds at most ${String(PINNED_MAX_PER_PAGE)} records, whatever \`per_page\` asks for`,
    encodedIn: PLAN_FILE,
  };
  const defaultBase = {
    id: "zendesk.pagination.default-per-page",
    vendor: "zendesk" as const,
    claim: `a request that names no \`per_page\` gets ${String(PINNED_MAX_PER_PAGE)} records`,
    encodedIn: PLAN_FILE,
  };
  const over = await zendeskCall(
    credential,
    `zendesk · ask for ${String(OVER_CAP)} results, to observe the cap`,
    `${ACCOUNT_TICKETS}&per_page=${String(OVER_CAP)}`,
  );
  const overLength = listLength(over.body, "results");
  if (over.status !== 200 || overLength === undefined) {
    return [
      assumption(capBase, "UNVERIFIABLE", `the search answered ${String(over.status)} with no readable \`results\``),
      assumption(defaultBase, "UNVERIFIABLE", "the cap probe did not answer, so the default cannot be read either"),
    ];
  }
  if (overLength < PINNED_MAX_PER_PAGE) {
    return [
      assumption(
        capBase,
        "UNVERIFIABLE",
        `asking for ${String(OVER_CAP)} returned fewer than ${String(PINNED_MAX_PER_PAGE)} results — this account does not hold enough tickets to reach the ceiling`,
      ),
      assumption(
        defaultBase,
        "UNVERIFIABLE",
        "the account holds fewer records than a full page, so a short default and a short account look the same",
      ),
    ];
  }
  const cap = assumption(
    capBase,
    overLength === PINNED_MAX_PER_PAGE ? "HOLDS" : "BROKEN",
    `asked ${String(OVER_CAP)}, received ${String(overLength)} — the pinned ceiling is ${String(PINNED_MAX_PER_PAGE)}`,
  );
  const bare = await zendeskCall(
    credential,
    "zendesk · ask with no per_page, to observe the default",
    ACCOUNT_TICKETS,
  );
  const bareLength = listLength(bare.body, "results");
  if (bare.status !== 200 || bareLength === undefined) {
    return [
      cap,
      assumption(defaultBase, "UNVERIFIABLE", `the search answered ${String(bare.status)} with no readable \`results\``),
    ];
  }
  return [
    cap,
    assumption(
      defaultBase,
      bareLength === PINNED_MAX_PER_PAGE ? "HOLDS" : "BROKEN",
      `a request naming no per_page returned ${String(bareLength)} records while a full page holds ${String(PINNED_MAX_PER_PAGE)}`,
    ),
  ];
}

export async function zendeskShapeAssumptions(
  credential: ZendeskCredential,
  targets: ZendeskTargets,
): Promise<Assumption[]> {
  const found = await collections(credential, targets);
  const search = await zendeskCall(
    credential,
    "zendesk · search.list pagination style",
    `${ACCOUNT_TICKETS}&per_page=${String(TINY_PAGE)}`,
  );
  found.push(
    styleAssumption(
      "search.list",
      "/api/v2/search",
      paginationStyle(search.body),
      bodyKeys(search.body),
    ),
  );
  found.push(...(await pageSizes(credential)));
  return found;
}
