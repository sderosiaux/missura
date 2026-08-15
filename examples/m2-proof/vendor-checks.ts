import type { LinearClient } from "@linear/sdk";
import type { Octokit } from "octokit";
import {
  check,
  githubBase,
  SkipCheck,
  type CheckResult,
  type MissionClaims,
} from "./mission";

/**
 * The per-vendor checks: what a customer-scoped mission may and may not read
 * through each connector. They drive the official SDKs, unmodified, and take
 * no view on the mission's lifetime — revocation is the caller's story.
 */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SMUGGLED_REPO = "golang/go";

interface IssueNode {
  id: string;
  identifier?: string;
  customer?: { id: string; name?: string } | null;
}
interface IssuesData {
  issues: { nodes: IssueNode[] };
}

const ISSUES_QUERY =
  "query { issues(first: 20) { nodes { id identifier customer { id name } } } }";
const FILTERED_QUERY =
  "query($filter: IssueFilter) { issues(first: 20, filter: $filter) { nodes { id customer { id } } } }";
const ISSUE_QUERY = "query($id: String!) { issue(id: $id) { id title } }";

/** The single customer every returned issue must belong to. */
function soleCustomer(nodes: readonly IssueNode[]): string {
  const ids = new Set(nodes.map((n) => n.customer?.id ?? "<none>"));
  if (ids.size !== 1) {
    throw new Error(
      `expected every issue to belong to one customer, saw ${[...ids].join(", ")}`,
    );
  }
  const [only] = [...ids];
  if (only === undefined || only === "<none>") {
    throw new Error("an issue came back with no customer relation at all");
  }
  return only;
}

function repoOf(repositoryUrl: string): string {
  return repositoryUrl.split("/").slice(-2).join("/").toLowerCase();
}

async function expectStatus(
  url: string,
  token: string,
  status: number,
): Promise<string> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.text();
  if (res.status !== status) {
    throw new Error(`expected ${String(status)}, got ${String(res.status)} ${body}`);
  }
  return body;
}

export async function linearChecks(
  results: CheckResult[],
  linear: LinearClient,
): Promise<string | undefined> {
  let customerId: string | undefined;

  await check(results, "linear issues — all belong to the mission customer", async () => {
    const res = await linear.client.rawRequest<IssuesData, Record<string, never>>(
      ISSUES_QUERY,
    );
    const nodes = res.data?.issues.nodes ?? [];
    if (nodes.length === 0) {
      throw new SkipCheck(
        "the mission customer has no issues — pick a customer that has some",
      );
    }
    customerId = soleCustomer(nodes);
    return `${String(nodes.length)} issue(s), customer ${customerId}`;
  });

  const foreign = process.env.MISSURA_FOREIGN_CUSTOMER_ID?.trim() ?? NIL_UUID;
  await check(results, "linear issues — another customer's filter is overwritten", async () => {
    const res = await linear.client.rawRequest<
      IssuesData,
      { filter: Record<string, unknown> }
    >(FILTERED_QUERY, {
      filter: { customer: { id: { eq: foreign } } },
    });
    const nodes = res.data?.issues.nodes ?? [];
    const strays = nodes.filter((n) => n.customer?.id !== customerId);
    if (strays.length > 0) {
      throw new Error(
        `${String(strays.length)} issue(s) came back outside the mission customer`,
      );
    }
    return `asked for ${foreign}, got ${String(nodes.length)} issue(s), all ${customerId ?? "mission customer"}`;
  });

  await check(results, "linear issue(id) — a foreign issue is not found", async () => {
    const id = process.env.MISSURA_FOREIGN_ISSUE_ID?.trim() ?? "";
    if (id.length === 0) {
      throw new SkipCheck("set MISSURA_FOREIGN_ISSUE_ID to exercise this one");
    }
    try {
      const res = await linear.client.rawRequest<
        { issue: unknown },
        { id: string }
      >(ISSUE_QUERY, { id });
      throw new Error(`expected not found, got ${JSON.stringify(res.data)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/not found/i.test(message)) throw err;
      return "issue not found (404-shaped GraphQL error)";
    }
  });

  return customerId;
}

export async function githubChecks(
  results: CheckResult[],
  octokit: Octokit,
  claims: MissionClaims,
  token: string,
): Promise<void> {
  const mission = claims.repos.map((r) => r.toLowerCase());
  const inScope = claims.repos[0];

  await check(results, "github in-scope repo — allowed", async () => {
    if (inScope === undefined) {
      throw new SkipCheck("mission carries no repos — add --repo owner/name");
    }
    const [owner, name] = inScope.split("/");
    const res = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: owner ?? "",
      repo: name ?? "",
    });
    return `${res.data.full_name} — ${String(res.data.stargazers_count)} stars`;
  });

  await check(results, "github out-of-scope repo — 404, GitHub-shaped", async () => {
    const other = mission.includes("octokit/octokit.js")
      ? SMUGGLED_REPO
      : "octokit/octokit.js";
    const body = await expectStatus(`${githubBase()}/repos/${other}`, token, 404);
    if (body !== '{"message":"Not Found"}') {
      throw new Error(`404 but not GitHub-shaped: ${body}`);
    }
    return `${other} → 404 {"message":"Not Found"}`;
  });

  await check(results, "github search — smuggled repo: qualifier is stripped", async () => {
    if (mission.length === 0) {
      throw new SkipCheck("mission carries no repos — add --repo owner/name");
    }
    const res = await octokit.request("GET /search/issues", {
      q: `test repo:${SMUGGLED_REPO}`,
      advanced_search: "true",
    });
    const outside = res.data.items
      .map((item) => repoOf(item.repository_url))
      .filter((repo) => !mission.includes(repo));
    if (outside.length > 0) {
      throw new Error(`results from outside the mission: ${outside.join(", ")}`);
    }
    return `${String(res.data.items.length)} result(s), none from ${SMUGGLED_REPO}`;
  });
}
