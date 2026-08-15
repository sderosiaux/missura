import type { MissionScope } from "@missura/core";
import { signMissionToken, verifyMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  boot,
  closeAll,
  mint,
  OPERATOR_BEARER,
  OPERATOR_HEX,
  post,
  SIGNING_KEY,
} from "./operator.fixtures";

afterEach(closeAll);

describe("operator API — POST /v1/revoke", () => {
  it("revokes by token and stays 200 on a second revoke", async () => {
    const { base, store } = await boot();
    const minted = await mint(base);
    const { jti } = verifyMissionToken(minted.access_token, {
      key: SIGNING_KEY,
    });

    const first = await post(
      base,
      "/v1/revoke",
      JSON.stringify({ token: minted.access_token }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revoked: true });
    expect(store.isRevoked(jti)).toBe(true);

    const second = await post(
      base,
      "/v1/revoke",
      JSON.stringify({ token: minted.access_token }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ revoked: true });
  });

  it("revokes by mission_id", async () => {
    const { base, store } = await boot();
    const minted = await mint(base);

    const res = await post(
      base,
      "/v1/revoke",
      JSON.stringify({ mission_id: minted.mission_id }),
    );

    expect(res.status).toBe(200);
    expect(store.active()).toHaveLength(0);
  });

  it("takes effect on a signature-valid token this store has no record of", async () => {
    const { base, store } = await boot();
    // The proxy honours the signature, not the record: a mission dropped by a
    // concurrent write — or minted against another state file — is still a
    // live grant. Revoking it used to swallow `unknown mission` and answer
    // `{revoked: true}` over a token that kept working.
    const orphan = signMissionToken(
      {
        id: "msn_orphan",
        purpose: "support case 42",
        actor: "ops@local",
        scope: {},
        connections: [],
        allow: ["read"],
      },
      { key: SIGNING_KEY, ttlSeconds: 300 },
    );
    const { jti } = verifyMissionToken(orphan, { key: SIGNING_KEY });

    const res = await post(base, "/v1/revoke", JSON.stringify({ token: orphan }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(store.isRevoked(jti)).toBe(true);
  });

  it("answers 200 for an unknown token instead of confirming existence", async () => {
    const { base } = await boot();
    const res = await post(
      base,
      "/v1/revoke",
      JSON.stringify({ token: "msr_not-a-real-token" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
  });

  it("rejects a body with neither token nor mission_id with 400", async () => {
    const { base } = await boot();
    const res = await post(base, "/v1/revoke", JSON.stringify({}));
    const payload = (await res.json()) as { error: { field: string } };

    expect(res.status).toBe(400);
    expect(payload.error.field).toBe("token");
  });

  it("rejects a bad operator key with 401 and revokes nothing", async () => {
    const { base, store } = await boot();
    const minted = await mint(base);

    const res = await post(
      base,
      "/v1/revoke",
      JSON.stringify({ mission_id: minted.mission_id }),
      "Bearer deadbeef",
    );

    expect(res.status).toBe(401);
    expect(store.active()).toHaveLength(1);
  });
});

describe("operator API — GET /v1/missions", () => {
  it("lists active missions without any token material", async () => {
    const { base } = await boot();
    const minted = await mint(base);

    const res = await fetch(`${base}/v1/missions`, {
      headers: { authorization: OPERATOR_BEARER },
    });
    const text = await res.text();
    const payload = JSON.parse(text) as {
      missions: {
        id: string;
        purpose: string;
        actor: string;
        scope: MissionScope;
        expiresAt: number;
      }[];
    };

    expect(res.status).toBe(200);
    expect(payload.missions).toHaveLength(1);
    expect(payload.missions[0]?.id).toBe(minted.mission_id);
    expect(payload.missions[0]?.purpose).toBe("support case 42");
    expect(payload.missions[0]?.actor).toBe("ops@local");
    expect(payload.missions[0]?.scope).toEqual({ customer: "acme" });
    expect(payload.missions[0]?.expiresAt).toBeGreaterThan(0);
    expect(text).not.toContain("msr_");
    expect(text).not.toContain("access_token");
    expect(text).not.toContain("jti");
    expect(text).not.toContain(OPERATOR_HEX);
  });

  it("drops revoked missions from the listing", async () => {
    const { base } = await boot();
    const minted = await mint(base);
    await post(
      base,
      "/v1/revoke",
      JSON.stringify({ mission_id: minted.mission_id }),
    );

    const res = await fetch(`${base}/v1/missions`, {
      headers: { authorization: OPERATOR_BEARER },
    });
    const payload = (await res.json()) as { missions: unknown[] };

    expect(payload.missions).toHaveLength(0);
  });

  it("rejects a bad operator key with 401", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/missions`, {
      headers: { authorization: "Bearer 00" },
    });

    expect(res.status).toBe(401);
  });
});

describe("operator API — unknown routes", () => {
  it("answers 404 for an unknown path and for a wrong method", async () => {
    const { base } = await boot();
    const unknown = await fetch(`${base}/v1/anything`, {
      headers: { authorization: OPERATOR_BEARER },
    });
    const wrongMethod = await fetch(`${base}/v1/token`, {
      headers: { authorization: OPERATOR_BEARER },
    });

    expect(unknown.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
  });

  it("checks the operator key before the route", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/anything`);

    expect(res.status).toBe(401);
  });
});
