/**
 * Plumbing for the M3 proof: the bits that are not themselves the proof.
 *
 * Deliberately standalone — no @missura/* import, and no import from the M2
 * proof either. Everything here is something a normal SDK user could write,
 * which is the point: the guarantees under test must hold for a client the
 * proxy has never met.
 */

export interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

export interface MissionClaims {
  id: string;
  purpose: string;
  actor: string;
  customer?: string;
  repos: string[];
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * This script talks to real vendors through a running proxy: it is not a test
 * and must never be picked up by one. The opt-in is explicit so a CI runner, a
 * watcher or a stray `tsx check.ts` stops here instead of hitting the network
 * with someone's workspace.
 */
export function assertLive(): void {
  if (process.env.MISSURA_LIVE !== "1") {
    fail(
      "refusing to run: this is a live proof against real vendor APIs.\n" +
        "Start the proxy (missura run), then:\n" +
        "  missura exec --customer <name> --repo <owner/name> --purpose 'm3 proof' -- pnpm demo:m3\n" +
        "To run this file directly, set MISSURA_LIVE=1.",
    );
  }
}

/**
 * The red line: if a vendor credential is reachable from here, nothing this
 * script goes on to prove means anything. Runs before any network call.
 */
export function assertNoVendorCredentials(): string {
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

export function requireToken(): string {
  const token = (
    process.env.MISSION_TOKEN ??
    process.env.MISSURA_TOKEN ??
    ""
  ).trim();
  if (token.length === 0) {
    fail(
      "no mission token — run this under: missura exec --customer <name> --repo <owner/name> --purpose 'm3 proof' -- pnpm demo:m3",
    );
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { isRecord };

/**
 * Reads the mission's own description out of the token it was handed. The
 * payload is signed, not secret — the agent may read what it holds, it simply
 * cannot change it, and nothing here is trusted for a security decision: it is
 * used to know what to assert.
 */
export function readClaims(token: string): MissionClaims {
  const payload = token.replace(/^msr_/, "").split(".")[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    fail("MISSION_TOKEN is not a missura token");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.purpose !== "string" ||
    typeof parsed.actor !== "string" ||
    !isRecord(parsed.scope)
  ) {
    fail("MISSION_TOKEN carries no readable mission claims");
  }
  const scope = parsed.scope;
  const repos = Array.isArray(scope.repos)
    ? scope.repos.filter((r): r is string => typeof r === "string")
    : [];
  return {
    id: parsed.id,
    purpose: parsed.purpose,
    actor: parsed.actor,
    ...(typeof scope.customer === "string" ? { customer: scope.customer } : {}),
    repos,
  };
}

export function linearUrl(): string {
  return process.env.LINEAR_API_URL ?? "http://127.0.0.1:8481/graphql";
}

export function githubBase(): string {
  return process.env.GITHUB_API_URL ?? "http://127.0.0.1:8482";
}

/** Every check funnels through here so one failure never aborts the table. */
export async function check(
  results: CheckResult[],
  name: string,
  run: () => Promise<string>,
): Promise<void> {
  try {
    results.push({ name, status: "PASS", detail: await run() });
  } catch (err) {
    if (err instanceof SkipCheck) {
      results.push({ name, status: "SKIP", detail: err.message });
      return;
    }
    results.push({
      name,
      status: "FAIL",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** A check the operator did not give this run the inputs for. */
export class SkipCheck extends Error {}

export function table(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results
    .map((r) => `${r.status.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`)
    .join("\n");
}

/** The shape `endpoint.merge` returns: request options with a headers bag. */
interface EndpointOptions extends Record<string, unknown> {
  headers?: Record<string, string>;
}

interface HookRequest {
  (options: EndpointOptions): Promise<unknown>;
  endpoint: {
    merge(route: string, parameters: Record<string, unknown>): EndpointOptions;
  };
}

export interface MissionTokenAuth {
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
export function missionTokenAuth(token: string): MissionTokenAuth {
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
