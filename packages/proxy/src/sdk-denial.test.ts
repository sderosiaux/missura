import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { LinearClient, LinearError } from "@linear/sdk";
import { narrowLinear } from "@missura/connectors-linear";
import { signMissionToken, type MissuraDenial } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import type { NarrowFn } from "./narrow";
import { createServers, type ProxyServers } from "./server";

/**
 * The contract, driven by the OFFICIAL `@linear/sdk` rather than described:
 * a refusal an SDK cannot parse never reaches the agent that has to act on it,
 * so it is worse than useless (SPEC §12, §4.8bis).
 *
 * Everything here is in-process — the "vendor" is a local double that records
 * whether it was ever called, and a denied call must leave it untouched. No
 * network, no credentials, same code path `missura run` serves.
 */

const SIGNING_KEY = randomBytes(32);
const MISSION_CUSTOMER = "cust_acme_01";

const linearNarrow: NarrowFn = (req) =>
  narrowLinear(req.body, { linearCustomerId: MISSION_CUSTOMER });

const booted: ProxyServers[] = [];
let upstreamCalls = 0;

async function boot(): Promise<string> {
  upstreamCalls = 0;
  const running = await createServers({
    signingKey: SIGNING_KEY,
    isRevoked: (): boolean => false,
    emit: (): void => undefined,
    fetchImpl: (): Promise<Response> => {
      upstreamCalls += 1;
      return Promise.resolve(
        new Response('{"data":{}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
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

function client(apiUrl: string): LinearClient {
  // accessToken, not apiKey: the SDK then sends `Bearer <mission token>`, which
  // is what the proxy authenticates. The vendor key is injected proxy-side.
  return new LinearClient({
    accessToken: signMissionToken(
      {
        id: "msn_sdk",
        purpose: "sdk denial contract",
        actor: "tester@local",
        scope: { customer: "acme" },
        connections: ["linear"],
        allow: ["read", "search"],
      },
      { key: SIGNING_KEY, ttlSeconds: 60 },
    ),
    apiUrl,
  });
}

/**
 * Whatever the SDK threw, reduced to what MISSURA put on the wire. The SDK
 * also attaches the caller's own query and variables to its error object —
 * that echo is the client's, not ours, and asserting over it would test the
 * vendor library rather than the non-leak rule.
 */
function thrown(err: unknown): { error: LinearError; answer: string } {
  expect(err).toBeInstanceOf(LinearError);
  const error = err as LinearError;
  return {
    error,
    answer: JSON.stringify({
      message: error.message,
      errors: error.errors,
      response: error.raw?.response,
    }),
  };
}

function block(error: LinearError): MissuraDenial {
  const raw = error.raw?.response?.errors?.[0]?.extensions as
    { missura?: MissuraDenial } | undefined;
  const missura = raw?.missura;
  if (missura === undefined)
    throw new Error("no missura block in the envelope");
  return missura;
}

afterEach(async () => {
  await Promise.all(booted.map((running) => running.close()));
  booted.length = 0;
});

describe("the official @linear/sdk on a denied call", () => {
  it("parses the refusal instead of failing on it, and reads the remediation", async () => {
    const apiUrl = await boot();
    const linear = client(apiUrl);

    // A typed SDK method, denied by NARROW: `projects` has no proven relation
    // to the mission's customer.
    await expect(linear.projects()).rejects.toBeInstanceOf(LinearError);
    try {
      await linear.projects();
    } catch (err) {
      const { error } = thrown(err);
      // The SDK built one of ITS typed errors and surfaced a message — not an
      // opaque transport failure.
      expect(error.errors?.[0]?.message ?? "").toContain(
        "no proven relation to mission customer",
      );
      // …and what it surfaces carries the fix, not just the complaint.
      expect(error.errors?.[0]?.message ?? "").toContain("customer:acme");
      const missura = block(error);
      expect(missura.code).toBe("missura_out_of_mission_scope");
      expect(missura.mission?.scope).toBe("customer:acme");
      expect(missura.try_instead.join(" ")).toContain("issues");
    }
    expect(upstreamCalls).toBe(0);
  });

  it("never repeats the foreign id the caller guessed", async () => {
    const apiUrl = await boot();
    const linear = client(apiUrl);

    try {
      await linear.customer("cust_globex_99");
      expect.unreachable("expected the SDK to reject an out-of-scope customer");
    } catch (err) {
      const { answer } = thrown(err);
      expect(answer.toLowerCase()).not.toContain("globex");
    }
    expect(upstreamCalls).toBe(0);
  });

  /**
   * A refusal must leave the client usable: an SDK that cannot parse an error
   * poisons its own state, and the next call fails for the wrong reason.
   */
  it("stays usable after a denial — the second refusal is as parseable as the first", async () => {
    const apiUrl = await boot();
    const linear = client(apiUrl);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await linear.projects();
        expect.unreachable(
          "expected the SDK to reject an out-of-scope root field",
        );
      } catch (err) {
        const { error } = thrown(err);
        expect(block(error).code).toBe("missura_out_of_mission_scope");
      }
    }
    expect(upstreamCalls).toBe(0);
  });
});
