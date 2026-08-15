#!/usr/bin/env tsx
/**
 * M1 proof, run by a human on a real workspace:
 *
 *   missura init && missura run          # terminal 1
 *   MISSURA_TOKEN=$(missura token) pnpm demo:m1
 *
 * `pnpm demo:m1` sets MISSURA_LIVE=1; without it this script refuses to run,
 * because it hits real vendor APIs.
 *
 * It drives the OFFICIAL vendor SDKs — @linear/sdk and octokit, unmodified —
 * at the proxy instead of the vendor, with ZERO vendor credentials in this
 * process's environment. Reads succeed, everything uncataloged is denied.
 *
 * Deliberately standalone: no @missura/* import, no test double, nothing this
 * script can do that a normal SDK user could not.
 */
import { LinearClient } from "@linear/sdk";
import { Octokit } from "octokit";

const LINEAR_URL = "http://localhost:8481/graphql";
const GITHUB_BASE = "http://localhost:8482";
const DEFAULT_REPO = "octokit/octokit.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * This script talks to real vendors through a running proxy: it is not a test
 * and must never be picked up by one. The opt-in is explicit so a CI runner,
 * a watcher or a stray `tsx check.ts` stops here instead of hitting the
 * network with someone's workspace credentials.
 */
function assertLive(): void {
  if (process.env.MISSURA_LIVE !== "1") {
    fail(
      "refusing to run: this is a live proof against real vendor APIs.\n" +
        "Start the proxy (missura run), then: MISSURA_TOKEN=$(missura token) pnpm demo:m1\n" +
        "To run this file directly, set MISSURA_LIVE=1.",
    );
  }
}

/**
 * The whole point of M1: if a vendor credential is reachable from here, the
 * proxy proves nothing. This runs before any network call.
 */
function assertNoVendorCredentials(): string {
  const leaked = ["LINEAR_API_KEY", "GITHUB_TOKEN"].filter(
    (name) => (process.env[name] ?? "").length > 0,
  );
  if (leaked.length > 0) {
    fail(
      `vendor credentials present in env: ${leaked.join(", ")} — unset them, the agent must not hold them`,
    );
  }
  return "no LINEAR_API_KEY / GITHUB_TOKEN in env";
}

function requireToken(): string {
  const token = process.env.MISSURA_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    fail("MISSURA_TOKEN is required — get one with: missura token");
  }
  return token;
}

/** Every check funnels through here so one failure never aborts the table. */
async function check(
  results: CheckResult[],
  name: string,
  run: () => Promise<string>,
): Promise<void> {
  try {
    results.push({ name, ok: true, detail: await run() });
  } catch (err) {
    results.push({
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Denials are asserted over raw fetch rather than through the SDKs: the SDKs
 * wrap transport errors and hide the status code, and the contract under test
 * is exactly `403 + missura_denied`.
 */
async function expectDenied(
  url: string,
  token: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  const code = (body as { error?: { code?: string } }).error?.code;
  if (res.status !== 403 || code !== "missura_denied") {
    throw new Error(
      `expected 403 missura_denied, got ${String(res.status)} ${String(code)}`,
    );
  }
  const reason = (body as { error?: { reason?: string } }).error?.reason ?? "";
  return `403 missura_denied — ${reason}`;
}

/** The shape `endpoint.merge` returns: request options with a headers bag. */
interface EndpointOptions extends Record<string, unknown> {
  headers?: Record<string, string>;
}

/**
 * The `request` an auth-strategy hook receives: callable, and carrying the
 * `endpoint` builder Octokit uses to turn a route into request options.
 */
interface HookRequest {
  (options: EndpointOptions): Promise<unknown>;
  endpoint: {
    merge(route: string, parameters: Record<string, unknown>): EndpointOptions;
  };
}

interface MissionTokenAuth {
  (): Promise<{ type: string }>;
  hook(
    request: HookRequest,
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Octokit's built-in token strategy sends `token <t>`, and its constructor
 * ignores a `headers` option entirely — so the mission token is installed
 * through the official auth-strategy extension point instead, as `Bearer`.
 */
function missionTokenAuth(token: string): MissionTokenAuth {
  const auth = (): Promise<{ type: string }> =>
    Promise.resolve({ type: "missura" });
  return Object.assign(auth, {
    hook: async (
      request: HookRequest,
      route: string,
      parameters: Record<string, unknown>,
    ): Promise<unknown> => {
      const endpoint = request.endpoint.merge(route, parameters);
      endpoint.headers = {
        ...endpoint.headers,
        authorization: `Bearer ${token}`,
      };
      return request(endpoint);
    },
  });
}

function table(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results
    .map(
      (r) =>
        `${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`,
    )
    .join("\n");
}

async function main(): Promise<void> {
  assertLive();
  const envDetail = assertNoVendorCredentials();
  const token = requireToken();
  const repo = process.env.MISSURA_GITHUB_REPO?.trim() ?? DEFAULT_REPO;
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || name.length === 0) {
    fail(`MISSURA_GITHUB_REPO must be owner/repo, got: ${repo}`);
  }

  // accessToken (not apiKey) so the SDK sends `Bearer <mission token>`, which
  // is what the proxy authenticates; the vendor key is injected proxy-side.
  const linear = new LinearClient({ accessToken: token, apiUrl: LINEAR_URL });
  const octokit = new Octokit({
    baseUrl: GITHUB_BASE,
    authStrategy: (): MissionTokenAuth => missionTokenAuth(token),
  });

  const results: CheckResult[] = [
    { name: "env has no vendor credentials", ok: true, detail: envDetail },
  ];

  await check(results, "linear viewer (allow)", async () => {
    const viewer = await linear.viewer;
    return `viewer ${viewer.name} <${viewer.email}>`;
  });

  await check(results, "linear issues first:3 (allow)", async () => {
    const issues = await linear.issues({ first: 3 });
    return `${String(issues.nodes.length)} issue(s)`;
  });

  await check(results, `github GET /repos/${repo} (allow)`, async () => {
    const res = await octokit.request("GET /repos/{owner}/{repo}", {
      owner,
      repo: name,
    });
    return `${res.data.full_name} — ${String(res.data.stargazers_count)} stars`;
  });

  await check(results, "linear mutation (deny)", () =>
    expectDenied(LINEAR_URL, token, {
      method: "POST",
      body: JSON.stringify({
        query:
          'mutation { issueCreate(input: { title: "missura probe", teamId: "probe" }) { success } }',
      }),
    }),
  );

  await check(results, "github GET /user (deny)", () =>
    expectDenied(`${GITHUB_BASE}/user`, token),
  );

  process.stdout.write(`${table(results)}\n`);
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    process.stderr.write(`\n${String(failed)} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nM1 proof: all checks passed\n");
}

await main();
