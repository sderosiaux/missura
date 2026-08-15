import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHomes, initedHarness, type Harness } from "./harness.fixtures";
import { revokeCommand } from "./missions";
import { resolveHome } from "./paths";
import { runCommand, type RunningProxy } from "./run";

const ENTITIES = {
  "customer:acme": {
    "linear.customer": "c_18",
    "github.repos": ["acme-corp/product"],
  },
};

interface Upstream {
  url: string;
  body: string;
}

function origin(server: Server): string {
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * A vendor double that records every call. Its real job is negative: a request
 * NARROW refuses must leave this array empty — a 404 produced after the vendor
 * was asked would still have leaked the question.
 */
function stubFetch(calls: Upstream[]): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: requestUrl(input),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return Promise.resolve(
      new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

async function boot(h: Harness, calls: Upstream[]): Promise<RunningProxy> {
  writeFileSync(
    resolveHome(h.io.env).entitiesPath,
    JSON.stringify(ENTITIES),
    "utf8",
  );
  return runCommand(h.io, {
    linearPort: 0,
    githubPort: 0,
    operatorPort: 0,
    fetchImpl: stubFetch(calls),
  });
}

function operatorBearer(h: Harness): string {
  return readFileSync(resolveHome(h.io.env).operatorKeyPath).toString("hex");
}

interface Minted {
  token: string;
  origins: { linear: string; github: string };
  missionId: string;
}

async function mint(h: Harness, servers: RunningProxy): Promise<Minted> {
  const res = await fetch(`${origin(servers.operator)}/v1/token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorBearer(h)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      authorization_details: [
        {
          type: "mission",
          purpose: "support case 42",
          actor: "ops@local",
          scope: { customer: "acme", repos: ["acme-corp/product"] },
          ttl: 300,
        },
      ],
    }),
  });
  const body = (await res.json()) as {
    access_token: string;
    mission_id: string;
    proxy_origins: { linear: string; github: string };
  };
  expect(res.status).toBe(200);
  return {
    token: body.access_token,
    origins: body.proxy_origins,
    missionId: body.mission_id,
  };
}

afterEach(cleanupHomes);

describe("missura run — operator plane and NARROW wired", () => {
  it("mints over HTTP, narrows both vendors and revokes in the hot path", async () => {
    const h = await initedHarness();
    const calls: Upstream[] = [];
    const servers = await boot(h, calls);

    try {
      const minted = await mint(h, servers);

      // The advertised origins must be the ports actually bound, not defaults.
      expect(minted.origins.linear).toBe(origin(servers.linear));
      expect(minted.origins.github).toBe(origin(servers.github));

      const auth = { authorization: `Bearer ${minted.token}` };

      // Out-of-mission repo: GitHub's own not-found shape, and no upstream call.
      const foreign = await fetch(`${minted.origins.github}/repos/octokit/octokit.js`, {
        headers: auth,
      });
      expect(foreign.status).toBe(404);
      expect(await foreign.text()).toBe('{"message":"Not Found"}');
      expect(calls).toHaveLength(0);

      // In-mission repo reaches the vendor.
      const allowed = await fetch(
        `${minted.origins.github}/repos/acme-corp/product`,
        { headers: auth },
      );
      expect(allowed.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/repos/acme-corp/product");

      // Linear: the entity map's customer id is injected into the document.
      const issues = await fetch(`${minted.origins.linear}/graphql`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ query: "{ issues { nodes { id } } }" }),
      });
      expect(issues.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.body).toContain("c_18");

      // Revocation is visible on the very next request, no restart.
      const revoked = await fetch(`${origin(servers.operator)}/v1/revoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorBearer(h)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mission_id: minted.missionId }),
      });
      expect(revoked.status).toBe(200);

      const after = await fetch(
        `${minted.origins.github}/repos/acme-corp/product`,
        { headers: auth },
      );
      expect(after.status).toBe(401);
      expect(calls).toHaveLength(2);
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("honours a revoke written by a separate store, on the next request", async () => {
    const h = await initedHarness();
    const calls: Upstream[] = [];
    const servers = await boot(h, calls);

    try {
      const minted = await mint(h, servers);
      const auth = { authorization: `Bearer ${minted.token}` };
      const target = `${minted.origins.github}/repos/acme-corp/product`;

      const allowed = await fetch(target, { headers: auth });
      expect(allowed.status).toBe(200);
      expect(calls).toHaveLength(1);

      // `missura revoke` from another terminal: its own MissionStore over the
      // same file, never the instance `missura run` captured at boot.
      expect(revokeCommand(h.io, minted.missionId)).toBe(0);

      // The very next request, with no sleep and no restart: the spec's < 5 s
      // revocation budget is met by construction, not by polling.
      const startedAt = Date.now();
      const after = await fetch(target, { headers: auth });
      expect(after.status).toBe(401);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(calls).toHaveLength(1);
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("refuses an unknown entity at mint time", async () => {
    const h = await initedHarness();
    const calls: Upstream[] = [];
    const servers = await boot(h, calls);

    try {
      const res = await fetch(`${origin(servers.operator)}/v1/token`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorBearer(h)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          authorization_details: [
            {
              type: "mission",
              purpose: "p",
              actor: "a",
              scope: { customer: "globex" },
              ttl: 300,
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(
        "unknown entity: customer:globex",
      );
    } finally {
      await servers.close();
    }
  }, 30_000);
});
