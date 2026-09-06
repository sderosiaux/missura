/**
 * Plumbing for the M10 proof: the bits that are not themselves the proof.
 *
 * Deliberately standalone — no @missura/* import, plain `fetch`. Two roles
 * live in this one script, and the split is the point: the AGENT, holding a
 * mission token and nothing else, and the OPERATOR, holding the operator key
 * and reaching the operator plane and nothing else. Neither role can do the
 * other's part with what it holds.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CheckResult {
  name: string;
  status: "PASS" | "FAIL";
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
 * This script DELETES A REAL COMMENT through a running proxy: it is not a
 * test and must never be picked up by one. The opt-in is explicit so a CI
 * runner, a watcher or a stray `tsx check.ts` stops here.
 */
export function assertLive(): void {
  if (process.env.MISSURA_LIVE !== "1") {
    fail(
      "refusing to run: this is a live proof that DELETES a real comment on a real GitHub issue.\n" +
        "Start the proxy (missura run), then:\n" +
        "  MISSURA_PROOF_COMMENT=<id> missura exec --repo <owner/name> --allow github.issue.comment.delete --purpose 'm10 proof' -- pnpm demo:m10\n" +
        "To run this file directly, set MISSURA_LIVE=1.",
    );
  }
}

/** The red line: a vendor credential reachable from here voids the proof. */
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
      "no mission token — run this under: missura exec --repo <owner/name> --allow github.issue.comment.delete --purpose 'm10 proof' -- pnpm demo:m10",
    );
  }
  return token;
}

/** The comment to delete. Given, never chosen: this script picks nothing. */
export function requireComment(): number {
  const raw = (process.env.MISSURA_PROOF_COMMENT ?? "").trim();
  const id = Number(raw);
  if (raw.length === 0 || !Number.isInteger(id) || id <= 0) {
    fail(
      "MISSURA_PROOF_COMMENT must be the id of an existing issue comment in the mission's repository — the one `pnpm demo:m8` created, for instance. This proof never chooses one.",
    );
  }
  return id;
}

/**
 * The operator's own bearer, read from the install `missura run` boots
 * from: `MISSURA_HOME/operator.key`, 32 raw bytes, presented as hex. This
 * is the one thing that makes this script the operator; the agent half of
 * it never touches it.
 */
export function operatorBearer(): string {
  const home = (process.env.MISSURA_HOME ?? "").trim() || join(homedir(), ".missura");
  const path = join(home, "operator.key");
  if (!existsSync(path)) fail(`no operator key at ${path} — is this the install missura run boots from?`);
  return `Bearer ${readFileSync(path).toString("hex")}`;
}

export function operatorBase(): string {
  return process.env.MISSURA_OPERATOR_URL ?? "http://127.0.0.1:8480";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The mission's own description, read off the token it holds; signed, not secret. */
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

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** One call through the proxy, with the mission token and nothing else: the agent. */
export async function call(
  token: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Answer> {
  return answer(
    await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

/** One call to the operator plane, with the operator key and nothing else: the operator. */
export async function operatorCall(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Answer> {
  return answer(
    await fetch(`${operatorBase()}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: operatorBearer(),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
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
    results.push({
      name,
      status: "FAIL",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export function table(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results
    .map((r) => `${r.status.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`)
    .join("\n");
}
