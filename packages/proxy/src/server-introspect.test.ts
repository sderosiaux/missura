import { signMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { INTROSPECTION_PATH } from "./introspect";
import { boot, live, SIGNING_KEY, stopAll } from "./server.fixtures";

/**
 * The introspection route over real HTTP, on every data-plane listener: the
 * mission token is the only credential involved, the vendor is never reached,
 * and a listener the mission does not cover answers all the same.
 */

function narrowToken(): string {
  return signMissionToken(
    {
      id: "msn_narrow",
      purpose: "introspection over http",
      actor: "tester@local",
      scope: { entity: "customer:zoetis" },
      connections: ["github"],
      allow: ["read", "search"],
      degraded: [{ system: "linear", reason: "link_proposed" }],
    },
    { key: SIGNING_KEY, ttlSeconds: 60 },
  );
}

afterEach(stopAll);

describe("proxy server — GET /missura/mission", () => {
  it("answers on the listener the mission covers and on the one it does not", async () => {
    const { linearUrl, githubUrl } = await boot();
    const headers = { authorization: `Bearer ${narrowToken()}` };

    for (const origin of [githubUrl, linearUrl]) {
      const res = await fetch(`${origin}${INTROSPECTION_PATH}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        entity: "customer:zoetis",
        systems: ["github"],
        degraded: [{ system: "linear", reason: "link_proposed" }],
        // The proxy's real catalogue, cut to the mission: GitHub's read only.
        operations: [{ name: "github.issues.for_entity", effect: "read" }],
      });
    }
    expect(live.upstream?.received).toEqual([]);
  });

  it("refuses a missing token in the listener's own envelope", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(`${githubUrl}${INTROSPECTION_PATH}`);
    const payload = (await res.json()) as { missura: { code: string } };

    expect(res.status).toBe(401);
    expect(payload.missura.code).toBe("missura_unauthenticated");
    expect(live.upstream?.received).toEqual([]);
  });
});
