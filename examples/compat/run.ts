#!/usr/bin/env tsx
/**
 * THE COMPATIBILITY SUITE — run by a human, against their own workspaces.
 *
 *   MISSURA_LIVE=1 pnpm compat
 *
 * It calls each vendor DIRECTLY with the vendor's own credential, then makes
 * the SAME call through a missura booted in this process with a mission token,
 * and compares. Two halves, one exit code:
 *
 *   HALF A  the facts about the vendor that a connector's code encodes, checked
 *           against the vendor. A BROKEN one fails the run and names the source
 *           file to open. This is the half that would have caught M2's
 *           `Issue.customer`, which does not exist and never did.
 *   HALF B  every catalogued operation, called both ways and classified. Only
 *           `unsafe` fails — a difference a typed SDK consumer cannot survive.
 *
 * READ-ONLY, asserted and not promised: every call in this process — this
 * file's own, and the ones the proxy makes — goes through `assertReadOnly` in
 * `http.ts`, which refuses any method but GET/HEAD/OPTIONS and allows exactly
 * one POST: a GraphQL document PARSED and proven to contain no mutation. That
 * function is covered by `http.test.ts`, which runs in CI with no credentials.
 * Every call announces itself on stderr before it is made.
 *
 * INPUTS — all optional, each missing one SKIPS its connector and never fails:
 *   LINEAR_API_KEY + MISSURA_LINEAR_CUSTOMER_ID   a Customer.id (UUID)
 *   GITHUB_TOKEN   + MISSURA_GITHUB_REPO          owner/name
 *   ZENDESK_SUBDOMAIN + ZENDESK_EMAIL + ZENDESK_API_TOKEN
 *   ZENDESK_ORGANIZATION_ID    the organization the mission covers
 *   ZENDESK_ORGANIZATION_ID_2  a second one — without it, whether repeated
 *                              `organization:` terms AND or OR is UNVERIFIABLE
 *
 * OUTPUTS — both committed, and neither carries a vendor response body:
 *   examples/compat/manifests/{linear,github,zendesk}.json  the coverage
 *                              manifest per connector (PRD F-014)
 *   examples/compat/manifests/report.md
 */
import { manifests, writeArtifacts } from "./artifacts";
import type { Observation } from "./exchange";
import { assertLive, credentials, type Assumption } from "./harness";
import { bootProxy, connectionsOf } from "./proxy";
import { failed, renderReport, renderSummary, type ReportInput } from "./report";
import { githubSection, linearSection, zendeskSection } from "./sections";

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
  assertLive();
  const { credentials: creds, skips } = credentials();
  const exercised = connectionsOf(creds);

  for (const [vendor, reason] of Object.entries(skips)) {
    say(`SKIP  ${vendor.padEnd(8)} ${reason}`);
  }
  say(
    exercised.length === 0
      ? "\nNo connector has credentials in this environment. Nothing will be called.\n"
      : `\nExercising: ${exercised.join(", ")}. Every call is announced below before it is made.\n`,
  );

  const assumptions: Assumption[] = [];
  const observations: Observation[] = [];
  if (exercised.length > 0) {
    const proxy = await bootProxy(creds, say);
    say(
      `missura is up in-process — linear ${proxy.origins.linear}, github ${proxy.origins.github}${proxy.origins.zendesk === "" ? "" : `, zendesk ${proxy.origins.zendesk}`}\n`,
    );
    try {
      for (const section of [
        await linearSection(creds, proxy),
        await githubSection(creds, proxy),
        await zendeskSection(creds, proxy),
      ]) {
        assumptions.push(...section.assumptions);
        observations.push(...section.observations);
      }
    } finally {
      await proxy.close();
    }
    say(
      `\n${String(proxy.events.length)} decision(s) were recorded by the proxy for this run.`,
    );
  }

  const input: ReportInput = { assumptions, observations, skips, exercised };
  const report = renderReport(input);
  const written = writeArtifacts(manifests(observations, assumptions), report);

  process.stdout.write(`${report}\n`);
  say(`\n${renderSummary(input)}`);
  for (const path of written) say(`wrote ${path}`);

  if (failed(input)) {
    say(
      "\nFAILED — a BROKEN assumption or an `unsafe` operation. The verdict section names the file to open.",
    );
    process.exit(1);
  }
  say(
    exercised.length === 0
      ? "\nNothing ran. A skip proves nothing — set the credentials above to make this suite say something."
      : "\nNo assumption broke and no operation was unsafe.",
  );
}

await main();
