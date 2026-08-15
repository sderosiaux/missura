import type { MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import { filterTask } from "./filter";
import {
  ZENDESK_NOT_FOUND_BODY,
  ZENDESK_NOT_FOUND_MESSAGE,
  type NarrowResult,
} from "./narrow";
import { handle } from "./pipeline";
import {
  bodyText,
  CLAIMS,
  harness,
  request,
  type Harness,
} from "./pipeline.fixtures";
import { FORWARDED_RESPONSE_HEADERS } from "./transport";

/**
 * The `zendesk404` deny shape: a refusal the vendor's own clients read as
 * absence, and the vendor headers a Zendesk client needs to back off.
 */

const ZENDESK_CLAIMS: MissionClaims = { ...CLAIMS, connections: ["zendesk"] };

function zendesk(narrowed: NarrowResult): Harness {
  return harness({
    provider: "zendesk",
    upstreamBase: "https://acme.zendesk.com",
    verifyToken: (): MissionClaims => ZENDESK_CLAIMS,
    narrow: (): NarrowResult => narrowed,
  });
}

describe("zendesk404 — a request-side refusal", () => {
  it("answers 404 with Zendesk's own absence vocabulary and the block", async () => {
    const { deps, calls } = zendesk({
      decision: "deny",
      denyShape: "zendesk404",
      reason: "organization not in mission",
      missionScopeSize: 2,
    });
    const res = await handle(deps, request({ path: "/api/v2/tickets/9" }));
    expect(res.status).toBe(404);
    const body = JSON.parse(bodyText(res.body)) as Record<string, unknown>;
    expect(body.error).toBe("RecordNotFound");
    expect(body.description).toBe(ZENDESK_NOT_FOUND_MESSAGE);
    expect(body.missura).toBeTypeOf("object");
    // Nothing reached the vendor: the refusal is decided before the call.
    expect(calls).toHaveLength(0);
  });

  it("never names the refused target in the remediation", async () => {
    const { deps } = zendesk({
      decision: "deny",
      denyShape: "zendesk404",
      reason: "organization not in mission",
      missionScopeSize: 2,
    });
    const res = await handle(deps, request({ path: "/api/v2/tickets/9" }));
    const text = bodyText(res.body);
    expect(text).not.toContain("/api/v2/tickets/9");
    const block = (JSON.parse(text) as { missura: { remediation: string } })
      .missura;
    expect(block.remediation).toContain("2 organizations");
  });
});

describe("zendesk404 — a response-side refusal", () => {
  it("fails closed with the vendor's bare not-found, no block", () => {
    const task = filterTask({
      decision: "allow",
      denyShape: "zendesk404",
      filterPlan: { rules: [], strip: [] },
    });
    expect(task?.notFoundBody).toBe(ZENDESK_NOT_FOUND_BODY);
    expect(ZENDESK_NOT_FOUND_BODY).not.toContain("missura");
  });

  it("still hands GitHub its own not-found", () => {
    const task = filterTask({
      decision: "allow",
      denyShape: "github404",
      filterPlan: { rules: [], strip: [] },
    });
    expect(task?.notFoundBody).toBe('{"message":"Not Found"}');
  });
});

describe("relayed vendor headers", () => {
  /**
   * Zendesk spells its budget `X-Rate-Limit` / `X-Rate-Limit-Remaining`, not
   * GitHub's `x-ratelimit-*`, and answers 429 with `Retry-After`
   * (developer.zendesk.com, Rate limits). Without them an SDK behind the proxy
   * has to guess when to back off.
   */
  it("relays Zendesk's rate-limit budget", () => {
    expect(FORWARDED_RESPONSE_HEADERS).toContain("x-rate-limit");
    expect(FORWARDED_RESPONSE_HEADERS).toContain("x-rate-limit-remaining");
    expect(FORWARDED_RESPONSE_HEADERS).toContain("retry-after");
  });

  it("does not relay the job-queue budget of endpoints it refuses", () => {
    expect(FORWARDED_RESPONSE_HEADERS).not.toContain(
      "zendesk-ratelimit-inflight-jobs",
    );
  });

  it("hands the budget through on a real answer", async () => {
    const { deps } = harness(
      {
        provider: "zendesk",
        upstreamBase: "https://acme.zendesk.com",
        verifyToken: (): MissionClaims => ZENDESK_CLAIMS,
      },
      (): Promise<Response> =>
        Promise.resolve(
          new Response('{"tickets":[]}', {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-rate-limit": "700",
              "x-rate-limit-remaining": "699",
            },
          }),
        ),
    );
    const res = await handle(deps, request({ path: "/api/v2/tickets/1" }));
    expect(res.headers["x-rate-limit"]).toBe("700");
    expect(res.headers["x-rate-limit-remaining"]).toBe("699");
  });
});
