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
 *
 * The per-vendor checks live in ./vendor-checks.ts; this file owns the run
 * itself — what is in scope, the revocation moment, and the table at the end.
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
import { githubChecks, linearChecks } from "./vendor-checks";

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
