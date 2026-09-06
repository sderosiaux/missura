import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { DecisionEvent } from "@missura/core";
import { expect } from "vitest";
import { writeEntityGraph, type Harness } from "./harness.fixtures";
import { run } from "./index";
import { runCommand, type RunningProxy } from "./run";

/**
 * Shared rig for the milestone proofs: a child spawned by the real
 * `missura exec`, one vendor double for the three connectors, and readers for
 * what the run left behind — the mission record and the decision log.
 */

/**
 * What the M5/M6 child does with the mission it was handed: one call per
 * vendor, in each vendor's own SDK-shaped spelling, and a record of what it
 * is holding.
 */
export function childM5(repo: string, organization: string): string {
  return `
const fs = require("node:fs");
const auth = { authorization: "Bearer " + process.env.MISSION_TOKEN };
const status = async (url, init) => (await fetch(url, init)).status;
(async () => {
  const out = {
    holdsToken: (process.env.MISSION_TOKEN ?? "").startsWith("msr_"),
    holdsVendorKeys: ["LINEAR_API_KEY", "GITHUB_TOKEN", "ZENDESK_API_TOKEN"]
      .filter((n) => (process.env[n] ?? "").length > 0),
    linear: await status(process.env.LINEAR_API_URL, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ query: "{ issues { nodes { id } } }" }),
    }),
    github: await status(process.env.GITHUB_API_URL + "/repos/${repo}", {
      headers: auth,
    }),
    zendesk: await status(
      process.env.ZENDESK_API_URL +
        "/api/v2/organizations/${organization}/tickets.json",
      { headers: auth },
    ),
    // What the mission says it is, asked the way an agent would: the URL
    // from the environment, the token it already holds.
    mission: await (
      await fetch(process.env.MISSURA_MISSION_URL, { headers: auth })
    ).json(),
  };
  fs.writeFileSync(process.env.MISSURA_HOME + "/proof.json", JSON.stringify(out));
})();
`;
}

export interface Call {
  method: string;
  url: string;
  body: string;
  authorization: string;
}

function authorizationOf(init: RequestInit | undefined): string {
  const headers = new Headers(init?.headers ?? {});
  return headers.get("authorization") ?? "";
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * One double for the three vendors, answering each in its own envelope: the
 * proxy's FILTER reads the body, so a GraphQL answer handed to Zendesk would
 * fail closed and the proof would prove nothing.
 */
export function stubFetch(calls: Call[]): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authorization: authorizationOf(init),
    });
    // A deleted comment answers as GitHub does — nothing, 204.
    if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    // A ticket by id answers as Zendesk does — the ticket, owned by acme's
    // organization: it is what the egress proves itself against (M2).
    const ticket = /\/api\/v2\/tickets\/(\d+)$/.exec(url)?.[1];
    // A comment by id answers as GitHub does — the comment, with its own
    // `url` where the path says it lives: what the destroy proves (L8).
    const comment = /\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(url);
    // A posted comment answers as GitHub does — the created object.
    const body = ticket !== undefined
      ? JSON.stringify({ ticket: { id: Number(ticket), organization_id: 4200 } })
      : comment !== null && method === "GET"
      ? JSON.stringify({ id: Number(comment[2]), url: `https://api.github.com/repos/${comment[1] ?? ""}/issues/comments/${comment[2] ?? ""}` })
      : url.includes("/api/v2/")
      ? '{"tickets":[]}'
      : method === "POST" && url.includes("/comments")
        ? '{"id":9001}'
        : JSON.stringify({ data: { issues: { nodes: [] } } });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function port(server: Server): string {
  return String((server.address() as AddressInfo).port);
}

export async function boot(h: Harness, calls: Call[]): Promise<RunningProxy> {
  writeEntityGraph(h);
  return runCommand(h.io, {
    linearPort: 0,
    githubPort: 0,
    zendeskPort: 0,
    operatorPort: 0,
    fetchImpl: stubFetch(calls),
  });
}

/**
 * The command a human types: `missura exec --entity <entity> [flags] -- node
 * -e <child>`, aimed at the booted ports. `flags` is what a milestone adds
 * — M8's `--allow NAME`.
 */
export function execArgv(
  servers: RunningProxy,
  entity: string,
  child: string,
  flags: readonly string[] = [],
): string[] {
  const zendesk = servers.zendesk;
  if (zendesk === undefined) throw new Error("no zendesk listener was booted");
  return [
    "exec",
    "--entity",
    entity,
    ...flags,
    "--ttl",
    "30m",
    "--purpose",
    "m5 proof",
    "--linear-port",
    port(servers.linear),
    "--github-port",
    port(servers.github),
    "--zendesk-port",
    port(zendesk),
    "--",
    process.execPath,
    "-e",
    child,
  ];
}

/** The child's proof, as it wrote it; the caller names the shape it expects. */
export function proof(h: Harness): unknown {
  return JSON.parse(readFileSync(join(h.home, "proof.json"), "utf8"));
}

/** Runs the command and reads its proof. */
export async function exec<T>(
  h: Harness,
  servers: RunningProxy,
  entity: string,
  child: string,
  flags: readonly string[] = [],
): Promise<T> {
  const code = await run(execArgv(servers, entity, child, flags), h.io);
  expect(code.code).toBe(0);
  return proof(h) as T;
}

export interface Recorded {
  id: string;
  scope: { entity?: string };
  resolution?: {
    entityKey?: string;
    degraded: { system: string; reason: string; id: string }[];
  };
}

export function missions(h: Harness): Recorded[] {
  const state = JSON.parse(
    readFileSync(join(h.home, "missions.json"), "utf8"),
  ) as { missions: Recorded[] };
  return state.missions;
}

/** Every decision the run wrote, as the operator reads them back: the JSONL. */
export function events(h: Harness): DecisionEvent[] {
  const dir = join(h.home, "events");
  return readdirSync(dir).flatMap((file) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as DecisionEvent),
  );
}
