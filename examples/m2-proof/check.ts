#!/usr/bin/env tsx
/**
 * M2 proof, run by a human on a real workspace.
 *
 * Prerequisites:
 *   1. ~/.missura/entities.json maps a REAL customer of your Linear workspace
 *      and one of your repos, e.g.
 *      { "customer:acme": { "linear.customer": "<uuid>", "github.repos": ["you/your-repo"] } }
 *   2. missura run                                     # terminal 1
 *   3. missura exec --customer acme --repo you/your-repo \
 *        --purpose "m2 proof" -- pnpm demo:m2          # terminal 2
 *
 * `pnpm demo:m2` sets MISSURA_LIVE=1; without it this script refuses to run.
 *
 * Optional inputs:
 *   MISSURA_FOREIGN_ISSUE_ID     an issue id belonging to ANOTHER customer
 *   MISSURA_FOREIGN_CUSTOMER_ID  another customer's id (else a nil uuid is used)
 *
 * It drives the OFFICIAL vendor SDKs — @linear/sdk and octokit, unmodified —
 * at the proxy instead of the vendor, with ZERO vendor credentials in this
 * process's environment. What it proves: a customer-scoped mission cannot read
 * another customer's object by direct query, by global search, or by guessed id.
 */
import { LinearClient } from "@linear/sdk";
import { Octokit } from "octokit";
import { createInterface } from "node:readline/promises";
import {
  assertLive,
  assertNoVendorCredentials,
  check,
  fail,
  githubBase,
  linearUrl,
  missionTokenAuth,
  readClaims,
  requireToken,
  SkipCheck,
  table,
  type CheckResult,
  type MissionClaims,
  type MissionTokenAuth,
} from "./mission";

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

/**
 * Polls until the mission is dead, so the number in the table is measured
 * rather than asserted. The probe must be a call that WOULD succeed: a path
 * the catalog refuses would answer 403 forever and prove nothing.
 */
async function untilUnauthorized(
  probe: () => Promise<Response>,
  budgetMs: number,
): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const res = await probe();
    const elapsed = Date.now() - startedAt;
    if (res.status === 401) {
      return `401 after ${String(elapsed)} ms`;
    }
    if (elapsed > budgetMs) {
      throw new Error(
        `still ${String(res.status)} after ${String(elapsed)} ms — revocation did not take`,
      );
    }
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function linearChecks(
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

async function githubChecks(
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

/** A request this mission is allowed to make — until it is revoked. */
function livenessProbe(
  claims: MissionClaims,
  token: string,
): () => Promise<Response> {
  const auth = { authorization: `Bearer ${token}` };
  const repo = claims.repos[0];
  if (repo !== undefined) {
    return (): Promise<Response> =>
      fetch(`${githubBase()}/repos/${repo}`, { headers: auth });
  }
  return (): Promise<Response> =>
    fetch(linearUrl(), {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
}

async function revocationCheck(
  results: CheckResult[],
  claims: MissionClaims,
  token: string,
): Promise<void> {
  const probe = livenessProbe(claims, token);
  await check(results, "revocation — the next call is refused", async () => {
    if (!process.stdin.isTTY) {
      throw new SkipCheck("needs a terminal: it asks you to revoke by hand");
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      await rl.question(
        `\nIn another terminal run:  missura revoke ${claims.id}\nthen press enter here… `,
      );
    } finally {
      rl.close();
    }
    return untilUnauthorized(probe, 5000);
  });
}

async function main(): Promise<void> {
  assertLive();
  const envDetail = assertNoVendorCredentials();
  const token = requireToken();
  const claims = readClaims(token);
  if (claims.customer === undefined && claims.repos.length === 0) {
    fail("this mission is unscoped — mint one with --customer and/or --repo");
  }

  const linear = new LinearClient({
    accessToken: token,
    apiUrl: linearUrl(),
  });
  const octokit = new Octokit({
    baseUrl: githubBase(),
    authStrategy: (): MissionTokenAuth => missionTokenAuth(token),
  });

  const results: CheckResult[] = [
    { name: "env has no vendor credentials", status: "PASS", detail: envDetail },
  ];
  process.stderr.write(
    `mission ${claims.id} — ${claims.purpose} (${claims.actor})\n` +
      `scope: ${claims.customer ?? "-"} ${claims.repos.join(" ")}\n\n`,
  );

  if (claims.customer !== undefined) await linearChecks(results, linear);
  await githubChecks(results, octokit, claims, token);
  await revocationCheck(results, claims, token);

  process.stdout.write(`${table(results)}\n`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (failed > 0) {
    process.stderr.write(`\n${String(failed)} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nM2 proof: no check failed\n");
}

await main();
