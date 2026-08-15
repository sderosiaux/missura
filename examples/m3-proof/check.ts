#!/usr/bin/env tsx
/**
 * M3 proof, run by a human on a real workspace.
 *
 * WHAT IT PROVES — the M3 acceptance criterion, in `strict` mode (SPEC §2.2):
 * the OFFICIAL `@linear/sdk` TYPED methods work under a customer-scoped
 * mission and return no object outside it. M2 proved the credentials stay out
 * of the agent; M3 proves the objects do.
 *
 * SET UP FIRST — all four, or checks below will SKIP rather than pass:
 *
 *  1. ~/.missura/entities.json maps a REAL customer of YOUR Linear workspace
 *     and one of YOUR repos. The Linear value is the customer's UUID (Linear's
 *     `Customer.id`, not its name), and the customer must have at least THREE
 *     issues linked to it through customer NEEDS — that is the only link
 *     `@linear/sdk` 90 exposes, there is no `Issue.customer`:
 *
 *        {
 *          "customer:acme": {
 *            "linear.customer": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
 *            "github.repos": ["you/your-repo"]
 *          }
 *        }
 *
 *  2. The vault holds LINEAR_API_KEY and GITHUB_TOKEN (`npx missura init`), and
 *     YOUR OWN shell exports NEITHER: check 1 fails if either is in this
 *     process's env, and nothing after it would mean anything.
 *
 *  3. Terminal 1:  missura run
 *
 *  4. Terminal 2 — the mission needs BOTH scopes, `--customer` for Linear and
 *     `--repo` for GitHub; with one missing, that vendor's checks SKIP:
 *
 *        missura exec --customer acme --repo you/your-repo \
 *          --purpose "m3 proof" -- pnpm demo:m3
 *
 * `pnpm demo:m3` sets MISSURA_LIVE=1; without it this script refuses to run.
 * `missura exec` injects MISSION_TOKEN, LINEAR_API_URL and GITHUB_API_URL.
 *
 * Optional inputs:
 *   MISSURA_FOREIGN_CUSTOMER_ID  another customer's Linear id for check 6
 *                                (default: a nil uuid, which is refused too)
 *   MISSURA_SEARCH_QUERY         the GitHub search for check 5; must use `OR`
 *                                or a quoted phrase to be worth running
 *                                (default: `"fix" OR "bug"`)
 *
 * The checks live in ./linear-checks.ts and ./github-checks.ts; this file owns
 * the run — what is in scope, the order, the table, and the exit code.
 */
import { LinearClient } from "@linear/sdk";
import { Octokit } from "octokit";
import { githubHeadersCheck, githubSearchCheck } from "./github-checks";
import { linearDenialCheck, linearScopeChecks } from "./linear-checks";
import {
  assertLive,
  assertNoVendorCredentials,
  fail,
  githubBase,
  linearUrl,
  missionTokenAuth,
  readClaims,
  requireToken,
  table,
  type CheckResult,
  type MissionTokenAuth,
} from "./mission";

async function main(): Promise<void> {
  assertLive();
  // Check 1 first and unconditionally: every later check assumes this process
  // holds no vendor credential of its own, so it is not one row among seven —
  // it is the precondition, and it aborts rather than fails.
  const envDetail = assertNoVendorCredentials();
  const token = requireToken();
  const claims = readClaims(token);
  if (claims.customer === undefined && claims.repos.length === 0) {
    fail("this mission is unscoped — mint one with --customer and --repo");
  }

  const linear = new LinearClient({ accessToken: token, apiUrl: linearUrl() });
  const octokit = new Octokit({
    baseUrl: githubBase(),
    authStrategy: (): MissionTokenAuth => missionTokenAuth(token),
  });

  const results: CheckResult[] = [
    { name: "1 · env carries no vendor credentials", status: "PASS", detail: envDetail },
  ];
  process.stderr.write(
    `mission ${claims.id} — ${claims.purpose} (${claims.actor})\n` +
      `scope: ${claims.customer ?? "-"} ${claims.repos.join(" ")}\n\n`,
  );

  // The order is the human's reading order, not the vendors' — the table tells
  // one story: the SDK works (2, 3, 4), the search M2 refused works (5), a
  // refusal teaches without leaking (6), and the client can still see the
  // vendor's rate limits (7).
  const scoped = claims.customer !== undefined;
  if (!scoped) {
    process.stderr.write(
      "no customer in this mission — the Linear checks (2, 3, 4, 6) ARE the criterion; re-run with --customer\n\n",
    );
  }
  if (scoped) await linearScopeChecks(results, linear);
  await githubSearchCheck(results, octokit, claims);
  if (scoped) await linearDenialCheck(results, linear, claims);
  await githubHeadersCheck(results, octokit, claims);

  process.stdout.write(`${table(results)}\n`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (failed > 0) {
    process.stderr.write(`\n${String(failed)} check(s) failed\n`);
    process.exit(1);
  }
  const skipped = results.filter((r) => r.status === "SKIP").length;
  process.stdout.write(
    `\nM3 proof: no check failed${skipped > 0 ? ` (${String(skipped)} skipped — read the detail column, a skip proves nothing)` : ""}\n`,
  );
}

await main();
