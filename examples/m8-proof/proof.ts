/**
 * Plumbing for the M8 proof: the bits that are not themselves the proof.
 *
 * Deliberately standalone — no @missura/* import, plain `fetch`. Everything
 * here is something any HTTP client could do, which is the point: the
 * guarantees under test must hold for a client the proxy has never met.
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
  allow: string[];
  repos: string[];
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * This script POSTS A REAL COMMENT through a running proxy: it is not a test
 * and must never be picked up by one. The opt-in is explicit so a CI runner,
 * a watcher or a stray `tsx check.ts` stops here instead of writing to
 * someone's repository.
 */
export function assertLive(): void {
  if (process.env.MISSURA_LIVE !== "1") {
    fail(
      "refusing to run: this is a live proof that WRITES a comment on a real GitHub issue.\n" +
        "Start the proxy (missura run), then:\n" +
        "  MISSURA_PROOF_ISSUE=<n> missura exec --repo <owner/name> --allow github.issue.comment.create --purpose 'm8 proof' -- pnpm demo:m8\n" +
        "To run this file directly, set MISSURA_LIVE=1.",
    );
  }
}

/**
 * The red line: if a vendor credential is reachable from here, nothing this
 * script goes on to prove means anything. Runs before any network call.
 */
export function assertNoVendorCredentials(): string {
  if ((process.env.GITHUB_TOKEN ?? "").length > 0) {
    fail("GITHUB_TOKEN present in env — unset it, the agent must not hold it");
  }
  return "no GITHUB_TOKEN in env";
}

export function requireToken(): string {
  const token = (process.env.MISSION_TOKEN ?? "").trim();
  if (token.length === 0) {
    fail(
      "no mission token — run this under: missura exec --repo <owner/name> --allow github.issue.comment.create --purpose 'm8 proof' -- pnpm demo:m8",
    );
  }
  return token;
}

/** The issue to comment on. Given, never chosen: this script creates nothing. */
export function requireIssue(): number {
  const raw = (process.env.MISSURA_PROOF_ISSUE ?? "").trim();
  const issue = Number(raw);
  if (raw.length === 0 || !Number.isInteger(issue) || issue <= 0) {
    fail(
      "MISSURA_PROOF_ISSUE must be the number of an existing issue in the mission's repository — this proof never creates one",
    );
  }
  return issue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    !Array.isArray(parsed.allow) ||
    !isRecord(parsed.scope)
  ) {
    fail("MISSION_TOKEN carries no readable mission claims");
  }
  const scope = parsed.scope;
  return {
    id: parsed.id,
    purpose: parsed.purpose,
    actor: parsed.actor,
    allow: parsed.allow.filter((a): a is string => typeof a === "string"),
    repos: Array.isArray(scope.repos)
      ? scope.repos.filter((r): r is string => typeof r === "string")
      : [],
  };
}

export function githubBase(): string {
  return process.env.GITHUB_API_URL ?? "http://127.0.0.1:8482";
}

export function missionUrl(): string {
  return process.env.MISSURA_MISSION_URL ?? `${githubBase()}/missura/mission`;
}

export interface Answer {
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
}

/** One call through the proxy, with the mission token and nothing else. */
export async function call(
  token: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Answer> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** The missura block a refusal carries, wherever the vendor envelope put it. */
export function missuraBlock(answer: Answer): Record<string, unknown> | undefined {
  const body = answer.json;
  if (!isRecord(body)) return undefined;
  return isRecord(body.missura) ? body.missura : undefined;
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
