import {
  MissionExpiredError,
  type MissionClaims,
  type Operation,
  type OperationStep,
} from "@missura/core";
import { describe, expect, it } from "vitest";
import { INTROSPECTION_PATH } from "./introspect";
import { NO_APPROVALS } from "./approvals";
import { handle } from "./pipeline";
import {
  bodyText,
  CLAIMS,
  DENY,
  harness,
  request,
  restDenial,
} from "./pipeline.fixtures";

/**
 * The agent can ask what it is (SPEC §4.8, RFC 7662 in spirit): one route on
 * the data plane, authenticated by the mission token alone, answering from the
 * mission's own claims. A degraded agent that does not know it is degraded
 * becomes confidently wrong — "there are no Linear issues for this customer" —
 * which is the failure this route exists to prevent.
 */

const NOW = 1_700_000_000_000;

/** A mission minted narrow: Linear declined, GitHub and Zendesk in. */
const NARROW: MissionClaims = {
  ...CLAIMS,
  scope: { entity: "customer:zoetis" },
  connections: ["github", "zendesk"],
  degraded: [{ system: "linear", reason: "link_proposed" }],
  iat: Math.floor(NOW / 1000) - 60,
  exp: Math.floor(NOW / 1000) + 540,
};

function ask(path: string = INTROSPECTION_PATH): ReturnType<typeof request> {
  return request({ method: "GET", path });
}

const NONE: readonly OperationStep[] = [];

/** One read per connector, so the listing has something to leave out. */
const CATALOGUE: readonly Operation[] = [
  {
    name: "linear.issues.for_entity",
    connector: "linear",
    effect: "read",
    needs: "linear.customer",
    plan: (): readonly OperationStep[] => NONE,
  },
  {
    name: "github.issues.for_entity",
    connector: "github",
    effect: "read",
    needs: "github.repo",
    plan: (): readonly OperationStep[] => NONE,
  },
  {
    name: "zendesk.tickets.for_entity",
    connector: "zendesk",
    effect: "read",
    needs: "zendesk.organization",
    plan: (): readonly OperationStep[] => NONE,
  },
];

describe("introspection — GET /missura/mission", () => {
  it("answers from the mission's own claims, and never calls the vendor", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => NARROW,
      now: () => NOW,
      operations: {
        catalogue: CATALOGUE,
        resolveScope: () => undefined,
        pipelineFor: () => undefined,
        approvals: NO_APPROVALS,
      },
    });
    const res = await handle(h.deps, ask());

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(bodyText(res.body))).toEqual({
      entity: "customer:zoetis",
      purpose: "test",
      actor: "tester@local",
      expires_in: 540,
      allow: ["read"],
      systems: ["github", "zendesk"],
      degraded: [{ system: "linear", reason: "link_proposed" }],
      // The operations THIS mission may run — the Linear one is absent, not
      // marked unavailable.
      operations: [
        { name: "github.issues.for_entity", effect: "read" },
        { name: "zendesk.tickets.for_entity", effect: "read" },
      ],
    });
    expect(h.fetchCount()).toBe(0);
  });

  /**
   * The route sits BEFORE the connection check: the mission that most needs to
   * ask is the one this listener is not in, and refusing it here would make
   * "which listener may I ask" one more thing the agent has to be told.
   */
  it("answers on a listener the mission does not cover", async () => {
    const h = harness({
      provider: "linear",
      verifyToken: (): MissionClaims => NARROW,
    });
    const res = await handle(h.deps, ask());

    expect(res.status).toBe(200);
    expect((JSON.parse(bodyText(res.body)) as { systems: string[] }).systems)
      .toEqual(["github", "zendesk"]);
  });

  it("leaves an audit record like any other decision", async () => {
    const h = harness({ verifyToken: (): MissionClaims => NARROW });
    await handle(h.deps, ask());

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.decision).toBe("allow");
    expect(h.events[0]?.operation).toBe("missura.mission");
    expect(h.events[0]?.missionId).toBe(NARROW.id);
  });

  it("ignores a query string on the route", async () => {
    const h = harness({ verifyToken: (): MissionClaims => NARROW });
    const res = await handle(h.deps, ask(`${INTROSPECTION_PATH}?x=1`));

    expect(res.status).toBe(200);
  });

  /** Anything but a GET on the route is a vendor request, and the catalog decides. */
  it("falls through to the catalog on any other method", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => NARROW,
      decide: () => DENY,
    });
    const res = await handle(
      h.deps,
      request({ method: "POST", path: INTROSPECTION_PATH }),
    );

    expect(res.status).toBe(403);
    expect(restDenial(res.body).code).toBe("missura_operation_not_in_catalog");
  });
});

describe("introspection — refusals wear the listener's own envelope", () => {
  it("answers a bad token exactly as a vendor call with a bad token is answered", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => {
        throw new Error("invalid signature");
      },
      now: () => NOW,
    });
    const introspect = await handle(h.deps, ask());
    const vendor = await handle(h.deps, request());

    expect(introspect.status).toBe(401);
    expect(restDenial(introspect.body).code).toBe("missura_unauthenticated");
    expect(bodyText(introspect.body)).toBe(bodyText(vendor.body));
    expect(introspect.headers).toEqual(vendor.headers);
  });

  it("tells an expired mission that it expired", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => {
        throw new MissionExpiredError(NARROW);
      },
    });
    const res = await handle(h.deps, ask());

    expect(res.status).toBe(401);
    expect(restDenial(res.body).code).toBe("missura_mission_expired");
  });

  it("refuses a revoked mission before describing it", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => NARROW,
      isRevoked: (): boolean => true,
    });
    const res = await handle(h.deps, ask());

    expect(res.status).toBe(401);
    expect(restDenial(res.body).code).toBe("missura_mission_revoked");
    expect(bodyText(res.body)).not.toContain("link_proposed");
  });
});
