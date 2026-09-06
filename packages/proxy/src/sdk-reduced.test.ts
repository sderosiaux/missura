import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { LinearClient } from "@linear/sdk";
import { narrowLinear } from "@missura/connectors-linear";
import { signMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import type { NarrowFn } from "./narrow";
import { createServers, type ProxyServers } from "./server";

/**
 * The REDUCED marker, driven by the OFFICIAL `@linear/sdk`: a filtered answer
 * carries `extensions.missura.reduced`, and the SDK's typed method still
 * parses the response around it. A marker that broke the client would be
 * worse than none — the agent would see a transport failure instead of a
 * page it should treat as partial.
 */

const SIGNING_KEY = randomBytes(32);
const MISSION_CUSTOMER = "c_18";

const linearNarrow: NarrowFn = (req) =>
  narrowLinear(req.body, { linearCustomerId: MISSION_CUSTOMER });

/**
 * An issue as the SDK's own query selects it, owned through its `needs`, with
 * the two nested objects the SDK's `Issue` model constructs unconditionally.
 */
function issue(id: string, customer: string): Record<string, unknown> {
  return {
    id,
    title: `Issue ${id}`,
    sharedAccess: { isShared: false, sharedWithUsers: [] },
    reactions: [],
    needs: { nodes: [{ customer: { id: customer } }] },
  };
}

const booted: ProxyServers[] = [];

async function boot(nodes: Record<string, unknown>[]): Promise<string> {
  const running = await createServers({
    signingKey: SIGNING_KEY,
    isRevoked: (): boolean => false,
    emit: (): void => undefined,
    fetchImpl: (): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes,
                pageInfo: {
                  hasNextPage: false,
                  hasPreviousPage: false,
                  endCursor: null,
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    linear: {
      vendorAuthHeader: "Bearer lin_never_leaves",
      port: 0,
      upstreamBase: "https://api.linear.app",
      narrow: linearNarrow,
    },
    github: {
      vendorAuthHeader: "Bearer ghp_never_leaves",
      port: 0,
      upstreamBase: "https://api.github.com",
      narrow: (): ReturnType<NarrowFn> => ({ decision: "allow" }),
    },
  });
  booted.push(running);
  const { port } = running.linear.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/graphql`;
}

function token(): string {
  return signMissionToken(
    {
      id: "msn_sdk",
      purpose: "sdk reduced contract",
      actor: "tester@local",
      scope: { entity: "customer:acme" },
      connections: ["linear"],
      allow: ["read", "search"],
      degraded: [],
    },
    { key: SIGNING_KEY, ttlSeconds: 60 },
  );
}

function client(apiUrl: string): LinearClient {
  return new LinearClient({ accessToken: token(), apiUrl });
}

afterEach(async () => {
  await Promise.all(booted.map((running) => running.close()));
  booted.length = 0;
});

describe("the official @linear/sdk on a reduced answer", () => {
  it("parses the page around the marker, and the marker is in `extensions`", async () => {
    const apiUrl = await boot([issue("i1", "c_18"), issue("i2", "c_globex")]);
    const linear = client(apiUrl);

    const issues = await linear.issues({ first: 5 });
    expect(issues.nodes.map((node) => node.id)).toEqual(["i1"]);

    // The same call, one level down: the SDK's own GraphQL client hands the
    // extensions back, so an agent that wants the flag can read it.
    const raw = await linear.client.rawRequest<
      unknown,
      Record<string, never>
    >("query { issues(first: 5) { nodes { id title } } }");
    expect(raw.extensions).toEqual({ missura: { reduced: true } });
    expect(JSON.stringify(raw)).not.toContain("c_globex");
  });

  it("carries no marker when nothing was removed", async () => {
    const apiUrl = await boot([issue("i1", "c_18")]);
    const linear = client(apiUrl);

    const issues = await linear.issues({ first: 5 });
    expect(issues.nodes.map((node) => node.id)).toEqual(["i1"]);

    const raw = await linear.client.rawRequest<
      unknown,
      Record<string, never>
    >("query { issues(first: 5) { nodes { id title } } }");
    expect(raw.extensions).toBeUndefined();
  });
});
