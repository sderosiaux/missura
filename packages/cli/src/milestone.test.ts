import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHomes,
  GITHUB_TOKEN,
  initedHarness,
  LINEAR_KEY,
  writeEntityGraph,
  ZENDESK_EMAIL,
  ZENDESK_INIT_ENV,
  ZENDESK_TOKEN,
  type Harness,
} from "./harness.fixtures";
import { run } from "./index";
import { runCommand, type RunningProxy } from "./run";

/**
 * THE M5 PROOF, end to end and through the CLI a human actually types.
 *
 *   missura exec --entity customer:acme --ttl 30m -- <cmd>
 *
 * resolves through the ENTITY GRAPH — not a flat map, not a `customer:` prefix
 * glued onto a name — and the child it spawns reaches every system a human
 * confirmed for that entity, on all three connectors, holding no vendor
 * credential of any kind.
 *
 * And the other half, which is the one the graph exists for: an entity whose
 * Linear link is only PROPOSED mints a mission WITHOUT Linear, that says so.
 * The mission is narrower, it is not refused, and the reason is on the record
 * by name — a bad inference costs reach, never somebody else's data.
 */

/**
 * What the child does with the mission it was handed: one call per vendor, in
 * each vendor's own SDK-shaped spelling, and a record of what it is holding.
 */
function child(repo: string, organization: string): string {
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

interface Call {
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
function stubFetch(calls: Call[]): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authorization: authorizationOf(init),
    });
    const body = url.includes("/api/v2/")
      ? '{"tickets":[]}'
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

async function boot(h: Harness, calls: Call[]): Promise<RunningProxy> {
  writeEntityGraph(h);
  return runCommand(h.io, {
    linearPort: 0,
    githubPort: 0,
    zendeskPort: 0,
    operatorPort: 0,
    fetchImpl: stubFetch(calls),
  });
}

interface Proof {
  holdsToken: boolean;
  holdsVendorKeys: string[];
  linear: number;
  github: number;
  zendesk: number;
  mission: Record<string, unknown>;
}

async function exec(
  h: Harness,
  servers: RunningProxy,
  entity: string,
  target: { repo: string; organization: string },
): Promise<Proof> {
  const zendesk = servers.zendesk;
  if (zendesk === undefined) throw new Error("no zendesk listener was booted");
  const code = await run(
    [
      "exec",
      "--entity",
      entity,
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
      child(target.repo, target.organization),
    ],
    h.io,
  );
  expect(code.code).toBe(0);
  return JSON.parse(readFileSync(join(h.home, "proof.json"), "utf8")) as Proof;
}

interface Recorded {
  scope: { entity?: string };
  resolution?: {
    entityKey?: string;
    degraded: { system: string; reason: string; id: string }[];
  };
}

function missions(h: Harness): Recorded[] {
  const state = JSON.parse(
    readFileSync(join(h.home, "missions.json"), "utf8"),
  ) as { missions: Recorded[] };
  return state.missions;
}

afterEach(cleanupHomes);

describe("M5 — one entity key, every confirmed system, through the graph", () => {
  it("reaches linear, github and zendesk under one --entity mission", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const proof = await exec(h, servers, "customer:acme", {
        repo: "acme-corp/product",
        organization: "4200",
      });

      expect(proof.holdsToken).toBe(true);
      // The red line: three vendors reached, no vendor credential in the child.
      expect(proof.holdsVendorKeys).toEqual([]);
      expect(proof.linear).toBe(200);
      expect(proof.github).toBe(200);
      expect(proof.zendesk).toBe(200);

      // Every call carried the graph's confirmed id, none of them the agent's.
      expect(calls).toHaveLength(3);
      expect(calls[0]?.body).toContain("c_18");
      expect(calls[1]?.url).toContain("/repos/acme-corp/product");
      expect(calls[2]?.url).toContain("/api/v2/organizations/4200/tickets");

      // And each one carried its OWN vendor's credential, taken from the vault
      // `missura init` wrote — the Zendesk call in particular, whose whole
      // credential path (subdomain, agent email, API token, Basic header) had
      // no caller before this milestone.
      expect(calls[2]?.authorization).toBe(
        `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`, "utf8").toString("base64")}`,
      );
      expect(calls[1]?.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(calls[0]?.authorization).toBe(LINEAR_KEY);
      // The mission token is the agent's, and it never travels to a vendor.
      const missionToken = readFileSync(join(h.home, "proof.json"), "utf8");
      expect(missionToken).not.toContain(ZENDESK_TOKEN);
      for (const call of calls) expect(call.authorization).not.toMatch(/msr_/);
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("mints without Linear when its link is only proposed, and records why", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const proof = await exec(h, servers, "customer:zoetis", {
        repo: "acme-corp/zoetis",
        organization: "4300",
      });

      // The two confirmed systems are reached; Linear is refused on the
      // connection check, before anything is asked of the vendor.
      expect(proof.github).toBe(200);
      expect(proof.zendesk).toBe(200);
      expect(proof.linear).toBe(403);
      expect(calls.map((c) => c.url).some((u) => u.includes("graphql"))).toBe(
        false,
      );

      // And it says so, by name, on the mission the operator can read back.
      const record = missions(h).at(-1);
      expect(record?.scope.entity).toBe("customer:zoetis");
      expect(record?.resolution?.entityKey).toBe("customer:zoetis");
      expect(record?.resolution?.degraded).toEqual([
        { system: "linear", reason: "link_proposed", id: "c_77" },
      ]);
    } finally {
      await servers.close();
    }
  }, 30_000);
});

/**
 * THE M6 PROOF: the same narrow mission, asked by the agent itself. It learns
 * that Linear is out and WHY — and not which Linear customer somebody proposed.
 * The record above holds `c_77`; the agent's answer must not, whatever path it
 * took to get there: token, proxy, or the bytes on the wire.
 */
describe("M6 — the agent can ask what it is, and is told what it is not", () => {
  it("names the degraded system by reason class, and never by the proposed id", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const servers = await boot(h, []);

    try {
      const { mission } = await exec(h, servers, "customer:zoetis", {
        repo: "acme-corp/zoetis",
        organization: "4300",
      });

      expect(mission).toMatchObject({
        entity: "customer:zoetis",
        purpose: "m5 proof",
        allow: ["read", "search"],
        systems: ["github", "zendesk"],
        degraded: [{ system: "linear", reason: "link_proposed" }],
      });
      expect(Object.keys(mission).sort()).toEqual([
        "actor",
        "allow",
        "degraded",
        "entity",
        "expires_in",
        "operations",
        "purpose",
        "systems",
      ]);
      expect(JSON.stringify(mission)).not.toContain("c_77");
    } finally {
      await servers.close();
    }
  }, 30_000);
});
