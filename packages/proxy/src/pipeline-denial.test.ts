import {
  MissionExpiredError,
  type CatalogDecision,
  type MissionClaims,
  type MissuraDenial,
} from "@missura/core";
import { describe, expect, it } from "vitest";
import type { NarrowResult } from "./narrow";
import { handle } from "./pipeline";
import { bodyText, CLAIMS, harness, request } from "./pipeline.fixtures";

/**
 * SPEC §4.8bis: every refusal keeps the envelope the vendor's own SDK parses,
 * and carries the missura block next to it — `extensions.missura` on GraphQL,
 * a `missura` key on REST. These specs read the block out of the vendor shape,
 * never instead of it: an error the SDK cannot parse never reaches the agent.
 */

const SCOPED: MissionClaims = {
  ...CLAIMS,
  scope: { customer: "acme" },
  connections: ["linear", "github"],
  allow: ["read", "search"],
  exp: Math.floor(Date.now() / 1000) + 600,
};

function graphqlBlock(body: string): MissuraDenial {
  const parsed = JSON.parse(body) as {
    errors: { message: string; extensions: { missura: MissuraDenial } }[];
  };
  expect(parsed.errors).toHaveLength(1);
  const first = parsed.errors[0];
  if (first === undefined) throw new Error("no GraphQL error in the envelope");
  expect(first.message.length).toBeGreaterThan(0);
  return first.extensions.missura;
}

function restBlock(body: string): MissuraDenial {
  const parsed = JSON.parse(body) as {
    message: string;
    missura: MissuraDenial;
  };
  expect(parsed.message.length).toBeGreaterThan(0);
  return parsed.missura;
}

function linear(
  over: Record<string, unknown> = {},
): ReturnType<typeof harness> {
  return harness({
    provider: "linear",
    upstreamBase: "https://api.linear.app",
    verifyToken: (): MissionClaims => SCOPED,
    ...over,
  });
}

const GRAPHQL = { method: "POST", path: "/graphql", body: '{"query":"{ x }"}' };

describe("denial envelopes — linear (GraphQL)", () => {
  it("answers an unverifiable token with a GraphQL error and no mission block", async () => {
    const h = linear({
      verifyToken: (): MissionClaims => {
        throw new Error("invalid signature");
      },
    });
    const res = await handle(h.deps, request(GRAPHQL));

    expect(res.status).toBe(401);
    const block = graphqlBlock(bodyText(res.body));
    expect(block.code).toBe("missura_unauthenticated");
    expect(block.mission).toBeUndefined();
    expect(block.remediation).toContain("Authorization");
  });

  it("tells an expired mission it expired, from its own verified claims", async () => {
    const h = linear({
      verifyToken: (): MissionClaims => {
        throw new MissionExpiredError({ ...SCOPED, exp: 1 });
      },
    });
    const res = await handle(h.deps, request(GRAPHQL));

    expect(res.status).toBe(401);
    const block = graphqlBlock(bodyText(res.body));
    expect(block.code).toBe("missura_mission_expired");
    expect(block.mission?.scope).toBe("customer:acme");
    expect(block.mission?.expires_in).toBe(0);
    expect(block.remediation).toContain("operator");
  });

  it("tells a revoked mission it was revoked and points at the operator", async () => {
    const h = linear({ isRevoked: (): boolean => true });
    const res = await handle(h.deps, request(GRAPHQL));

    expect(res.status).toBe(401);
    const block = graphqlBlock(bodyText(res.body));
    expect(block.code).toBe("missura_mission_revoked");
    expect(block.remediation).toContain("operator");
    expect(block.try_instead).toEqual([]);
  });

  it("names the field the agent wrote and an in-scope alternative", async () => {
    const h = linear({
      narrow: (): NarrowResult => ({
        decision: "deny",
        reason: "root field `projects` is not narrowable under a mission scope",
      }),
    });
    const res = await handle(h.deps, request(GRAPHQL));

    expect(res.status).toBe(403);
    expect(h.fetchCount()).toBe(0);
    const block = graphqlBlock(bodyText(res.body));
    expect(block.code).toBe("missura_out_of_mission_scope");
    expect(block.remediation).toContain("`projects`");
    expect(block.remediation).toContain("customer:acme");
    expect(block.try_instead.join(" ")).toContain("issues");
  });

  it("keeps the vendor shape on an upstream failure", async () => {
    const h = linear({
      fetchImpl: (): Promise<Response> => Promise.reject(new Error("boom")),
    });
    const res = await handle(h.deps, request(GRAPHQL));

    expect(res.status).toBe(502);
    expect(graphqlBlock(bodyText(res.body)).code).toBe(
      "missura_upstream_error",
    );
  });

  it("keeps the vendor shape when missura itself fails, and says nothing else", async () => {
    const h = linear({
      decide: (): CatalogDecision => {
        throw new Error("catalog blew up");
      },
    });
    const res = await handle(h.deps, request(GRAPHQL));

    expect(res.status).toBe(500);
    const body = bodyText(res.body);
    expect(graphqlBlock(body).code).toBe("missura_internal");
    expect(body).not.toContain("catalog blew up");
  });
});

describe("denial envelopes — github (REST)", () => {
  it("names the connections the mission does cover", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => ({
        ...SCOPED,
        connections: ["linear"],
      }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(403);
    const block = restBlock(bodyText(res.body));
    expect(block.code).toBe("missura_connection_not_in_mission");
    expect(block.remediation).toContain("linear");
  });

  it("says an uncataloged route is not reachable by any mission", async () => {
    const deny: CatalogDecision = {
      decision: "deny",
      operation: "unknown",
      action: "unknown",
      reason: "path /user is not in the GitHub read catalog",
    };
    const h = harness({
      verifyToken: (): MissionClaims => SCOPED,
      decide: (): CatalogDecision => deny,
    });
    const res = await handle(h.deps, request({ path: "/user" }));

    expect(res.status).toBe(403);
    const block = restBlock(bodyText(res.body));
    expect(block.code).toBe("missura_operation_not_in_catalog");
    expect(block.reason).toBe(deny.reason);
    expect(block.remediation).toContain("catalog");
  });

  it("names the allowed actions and the one this call needed", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => ({ ...SCOPED, allow: ["search"] }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(403);
    const block = restBlock(bodyText(res.body));
    expect(block.code).toBe("missura_action_not_allowed");
    expect(block.mission?.allowed_actions).toEqual(["search"]);
    expect(block.remediation).toContain("read");
  });

  it("keeps GitHub's own not-found message and hides the detail in the block", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => SCOPED,
      narrow: (): NarrowResult => ({
        decision: "deny",
        denyShape: "github404",
        reason: "repo not in mission",
        missionScopeSize: 3,
      }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(404);
    const parsed = JSON.parse(bodyText(res.body)) as { message: string };
    // Byte-compatible with absence at the level an SDK reads first.
    expect(parsed.message).toBe("Not Found");
    const block = restBlock(bodyText(res.body));
    expect(block.code).toBe("missura_out_of_mission_scope");
    expect(block.remediation).toContain("3 repositories");
    expect(block.try_instead.join(" ")).toContain("/search/issues");
  });

  it("refuses a rewritten target that would leave the origin, actionably", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => SCOPED,
      narrow: (): NarrowResult => ({
        decision: "allow",
        path: "https://evil.example/steal",
      }),
    });
    const res = await handle(h.deps, request());

    expect(res.status).toBe(403);
    expect(restBlock(bodyText(res.body)).code).toBe("missura_invalid_target");
  });

  it("tells an oversized answer to ask for fewer objects", async () => {
    const huge = "x".repeat(64);
    const h = harness(
      { verifyToken: (): MissionClaims => SCOPED },
      (): Promise<Response> =>
        Promise.resolve(
          new Response(huge, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(11 * 1024 * 1024),
            },
          }),
        ),
    );
    const res = await handle(h.deps, request());

    expect(res.status).toBe(502);
    const block = restBlock(bodyText(res.body));
    expect(block.code).toBe("missura_response_too_large");
    expect(block.try_instead.join(" ")).toContain("per_page");
  });
});
