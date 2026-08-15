import { LinearError, type LinearClient } from "@linear/sdk";
import {
  check,
  isRecord,
  SkipCheck,
  type CheckResult,
  type MissionClaims,
} from "./mission";

/**
 * The Linear half of the M3 proof: the milestone's own acceptance criterion.
 *
 * Everything here goes through the OFFICIAL `@linear/sdk` TYPED methods —
 * `linear.issues({first})`, `linear.issue(id)`, `connection.fetchNext()`,
 * `linear.customer(id)`. Not `rawRequest`, because a hand-written document
 * proves only that a hand-written document works, and M3 claims more than that:
 * that the generated one does, fat fragments and all.
 *
 * The ONE hand-written document below is the instrument, not the claim: it
 * reads `needs` to decide who owns each issue. It has to be hand-written —
 * `@linear/sdk` 90 declares no `Issue.customer`, and its generated
 * `issue.needs()` document selects `projectAttachment { ...ProjectAttachment }`,
 * a type this connector has not classified, so the typed accessor is refused.
 * That is a coverage gap in the connector, not a hole in the enforcement.
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PAGE = 2;
const NO_CUSTOMER = "<none>";

/**
 * Ownership, read the way the enforcement engine reads it (SPEC §4.4.3): an
 * issue is in scope when AT LEAST ONE of its needs names the mission's
 * customer. An issue can be needed by several customers at once, so the
 * question is never "which customer owns this" but "is ours among them".
 */
const NEEDS_QUERY = `query($id: String!) {
  issue(id: $id) { id needs(first: 50) { nodes { id customer { id } } } }
}`;

interface NeedNode {
  id: string;
  customer?: { id: string } | null;
}

interface NeedsData {
  issue: { id: string; needs: { nodes: NeedNode[] } } | null;
}

async function needOwners(
  linear: LinearClient,
  issueId: string,
): Promise<string[]> {
  const res = await linear.client.rawRequest<NeedsData, { id: string }>(
    NEEDS_QUERY,
    { id: issueId },
  );
  const issue = res.data?.issue;
  if (issue === null || issue === undefined) {
    throw new Error(`issue ${issueId} came back from issues() but not on re-read`);
  }
  return issue.needs.nodes.map((need) => need.customer?.id ?? NO_CUSTOMER);
}

/** The customer ids every one of the returned issues names. */
function sharedOwners(perIssue: readonly (readonly string[])[]): string[] {
  const [head, ...rest] = perIssue;
  if (head === undefined) return [];
  return [...new Set(head)].filter(
    (id) => id !== NO_CUSTOMER && rest.every((owners) => owners.includes(id)),
  );
}

/** What the SDK surfaced, minus the echo of the caller's own request. */
function denialAnswer(error: LinearError): string {
  return JSON.stringify({
    message: error.message,
    errors: error.errors,
    response: error.raw?.response,
  });
}

function missuraBlock(error: LinearError): Record<string, unknown> {
  const extensions: unknown = error.raw?.response?.errors?.[0]?.extensions;
  const block: unknown = isRecord(extensions) ? extensions.missura : undefined;
  if (!isRecord(block)) {
    throw new Error(`the refusal carried no missura block: ${denialAnswer(error)}`);
  }
  return block;
}

function assertDenial(err: unknown, foreignId: string, scope: string): string {
  if (!(err instanceof LinearError)) {
    throw new Error(
      `the SDK could not parse the refusal — it surfaced as ${String(err)}`,
    );
  }
  const surfaced = error0(err);
  const block = missuraBlock(err);
  const remediation = typeof block.remediation === "string" ? block.remediation : "";
  if (!remediation.includes(scope)) {
    throw new Error(`the remediation does not name the mission scope: ${remediation}`);
  }
  const answer = denialAnswer(err).toLowerCase();
  if (answer.includes(foreignId.toLowerCase())) {
    throw new Error("the refusal repeated the identifier it refused");
  }
  return `${String(block.code)} — SDK read "${surfaced.slice(0, 60)}…", remediation names ${scope}`;
}

/** The message the SDK puts in front of the agent — the remediation rides in it. */
function error0(error: LinearError): string {
  const message = error.errors?.[0]?.message ?? "";
  if (message === "") {
    throw new Error(`the SDK built no readable GraphQL error: ${denialAnswer(error)}`);
  }
  return message;
}

/**
 * Checks 2, 3 and 4: the typed reads, what the `needs` collection carries, and
 * the SDK's own pagination over a set the proxy filtered. Check 6 lives in
 * `linearDenialCheck` because the table follows the order the human reads it
 * in, not the order the vendors fall in.
 */
export async function linearScopeChecks(
  results: CheckResult[],
  linear: LinearClient,
): Promise<void> {
  let owners: string[][] = [];

  await check(
    results,
    "2 · @linear/sdk typed reads — issues({first:5}) + issue(id), all in scope",
    async () => {
      const page = await linear.issues({ first: 5 });
      const head = page.nodes[0];
      if (head === undefined) {
        throw new SkipCheck(
          "the mission customer has no issues — mint the mission on a customer that has some",
        );
      }
      const single = await linear.issue(head.id);
      if (single.id !== head.id) {
        throw new Error(`issue(${head.id}) answered with ${single.id}`);
      }
      const perIssue: string[][] = [];
      for (const issue of page.nodes) {
        const found = await needOwners(linear, issue.id);
        if (found.length === 0) {
          throw new Error(
            `${issue.identifier} came back with no customer need at all — nothing proves it is in scope`,
          );
        }
        perIssue.push(found);
      }
      owners = perIssue;
      const shared = sharedOwners(perIssue);
      const only = shared[0];
      if (shared.length !== 1 || only === undefined) {
        throw new Error(
          `the ${String(page.nodes.length)} issues share ${String(shared.length)} customers, expected exactly one`,
        );
      }
      return `${String(page.nodes.length)} issue(s) + issue(${head.identifier}), every one needed by ${only}`;
    },
  );

  await check(
    results,
    "3 · linear needs — the collection itself names no other customer",
    () => {
      if (owners.length === 0) {
        throw new SkipCheck("no issues came back — nothing to inspect");
      }
      const seen = new Set(owners.flat());
      if (seen.has(NO_CUSTOMER)) {
        throw new Error(
          "a need came back with no customer relation — an unresolvable owner must be dropped, not served",
        );
      }
      if (seen.size !== 1) {
        throw new Error(`needs named ${String(seen.size)} customers: ${[...seen].join(", ")}`);
      }
      return Promise.resolve(
        `${String(owners.flat().length)} need(s) over ${String(owners.length)} issue(s), all ${[...seen][0] ?? ""}`,
      );
    },
  );

  await check(
    results,
    "4 · @linear/sdk pagination — a full page, then its cursor across a second",
    async () => {
      const page = await linear.issues({ first: PAGE });
      if (page.nodes.length < PAGE) {
        if (page.pageInfo.hasNextPage) {
          throw new Error(
            `asked for ${String(PAGE)}, got ${String(page.nodes.length)} while the connection reports another page — filtering short-changed it`,
          );
        }
        throw new SkipCheck(
          `the mission customer has ${String(page.nodes.length)} issue(s); this needs ${String(PAGE + 1)}`,
        );
      }
      if (!page.pageInfo.hasNextPage) {
        throw new SkipCheck(
          `the mission customer has exactly ${String(PAGE)} issue(s); this needs ${String(PAGE + 1)}`,
        );
      }
      const firstPage = page.nodes.map((node) => node.id);
      const cursor = page.pageInfo.endCursor;
      await page.fetchNext();
      const added = page.nodes.slice(firstPage.length);
      if (added.length === 0) {
        throw new Error("fetchNext() returned nothing while hasNextPage was true");
      }
      const repeated = added.filter((node) => firstPage.includes(node.id));
      if (repeated.length > 0) {
        throw new Error(
          `page 2 repeated ${String(repeated.length)} object(s) from page 1 — the cursor did not advance over the filtered set`,
        );
      }
      if (page.pageInfo.endCursor === cursor) {
        throw new Error("the cursor is unchanged after a second page");
      }
      return `first ${String(PAGE)} → ${String(added.length)} more, no repeats`;
    },
  );
}

/** Check 6: what a refusal teaches, and what it must never confirm. */
export async function linearDenialCheck(
  results: CheckResult[],
  linear: LinearClient,
  claims: MissionClaims,
): Promise<void> {
  const scope = `customer:${claims.customer ?? ""}`;

  await check(
    results,
    "6 · a denied call — vendor-parseable, remediation names the scope only",
    async () => {
      const foreign = process.env.MISSURA_FOREIGN_CUSTOMER_ID?.trim() ?? NIL_UUID;
      let served: string | undefined;
      try {
        const other = await linear.customer(foreign);
        served = other.id;
      } catch (err) {
        return assertDenial(err, foreign, scope);
      }
      throw new Error(`the proxy served customer ${served}`);
    },
  );
}
