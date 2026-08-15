import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { signMissionToken, type DecisionEvent } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { passThroughNarrow } from "./narrow";
import { createServers, type ProxyServers } from "./server";
import { startUpstream, type Upstream } from "./server.fixtures";

/**
 * The third listener. Zendesk's connector shipped with a catalog, a NARROW and
 * a parent proof, but nothing ever booted it: `createServers` knew two vendors,
 * so the only way to reach the Zendesk pipeline was a unit test calling
 * `handle` directly. A connector that cannot be booted cannot be proven against
 * the real vendor, which is the whole point of the compatibility suite.
 *
 * `upstreamBase` is REQUIRED here and nowhere else: a Zendesk origin is
 * `https://<subdomain>.zendesk.com`, so there is no default that is not a guess
 * at someone else's account.
 */
const SIGNING_KEY = randomBytes(32);
const ZENDESK_SECRET = "Basic zendesk-secret";

const events: DecisionEvent[] = [];
let running: ProxyServers | undefined;
let upstream: Upstream | undefined;

afterEach(async () => {
  await running?.close();
  await upstream?.close();
  running = undefined;
  upstream = undefined;
});

function token(): string {
  return signMissionToken(
    {
      id: "msn_zendesk",
      purpose: "compat",
      actor: "test@local",
      scope: {},
      connections: ["linear", "github", "zendesk"],
      allow: ["read", "search"],
    },
    { key: SIGNING_KEY, ttlSeconds: 60 },
  );
}

async function boot(): Promise<string> {
  const double = await startUpstream();
  upstream = double;
  events.length = 0;
  running = await createServers({
    signingKey: SIGNING_KEY,
    isRevoked: (): boolean => false,
    emit: (ev: DecisionEvent): void => {
      events.push(ev);
    },
    linear: {
      vendorAuthHeader: "Bearer linear",
      port: 0,
      upstreamBase: double.base,
      narrow: passThroughNarrow,
    },
    github: {
      vendorAuthHeader: "Bearer github",
      port: 0,
      upstreamBase: double.base,
      narrow: passThroughNarrow,
    },
    zendesk: {
      vendorAuthHeader: ZENDESK_SECRET,
      port: 0,
      upstreamBase: double.base,
      narrow: passThroughNarrow,
    },
  });
  const zendesk = running.zendesk;
  if (zendesk === undefined) throw new Error("no zendesk listener was booted");
  const { port } = zendesk.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

describe("createServers — the zendesk connection", () => {
  it("serves a cataloged Zendesk read with the Zendesk credential", async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/v2/organizations/42/tickets.json`, {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(203);
    expect(upstream?.received[0]?.url).toBe(
      "/api/v2/organizations/42/tickets.json",
    );
    // The Zendesk credential, and never one of the other two connections'.
    expect(upstream?.received[0]?.authorization).toBe(ZENDESK_SECRET);
    expect(events[0]?.provider).toBe("zendesk");
    expect(events[0]?.operation).toBe("organizations.tickets.list");
  });

  it("refuses an uncataloged Zendesk path without reaching the vendor", async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/v2/incremental/tickets.json`, {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(403);
    expect(upstream?.received).toHaveLength(0);
    expect(events[0]?.decision).toBe("deny");
    expect(events[0]?.operation).toBe("refused.incremental_exports");
  });

  it("boots the other two connections when no zendesk is configured", async () => {
    const double = await startUpstream();
    upstream = double;
    running = await createServers({
      signingKey: SIGNING_KEY,
      isRevoked: (): boolean => false,
      emit: (): void => {
        // Not what this assertion is about.
      },
      linear: {
        vendorAuthHeader: "Bearer linear",
        port: 0,
        upstreamBase: double.base,
        narrow: passThroughNarrow,
      },
      github: {
        vendorAuthHeader: "Bearer github",
        port: 0,
        upstreamBase: double.base,
        narrow: passThroughNarrow,
      },
    });

    expect(running.zendesk).toBeUndefined();
    expect(running.linear.listening).toBe(true);
  });
});
