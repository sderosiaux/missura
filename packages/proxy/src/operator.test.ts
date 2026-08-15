import { randomBytes } from "node:crypto";
import { verifyMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_OPERATOR_PORT } from "./operator";
import {
  boot,
  closeAll,
  mintPayload,
  OPERATOR_HEX,
  post,
  SIGNING_KEY,
  type TokenBody,
} from "./operator.fixtures";

afterEach(closeAll);

describe("operator API — defaults", () => {
  it("pins the operator port", () => {
    expect(DEFAULT_OPERATOR_PORT).toBe(8480);
  });
});

describe("operator API — POST /v1/token", () => {
  it("mints a mission whose token carries actor, purpose and scope", async () => {
    const { base } = await boot();
    const res = await post(base, "/v1/token", mintPayload());
    const payload = (await res.json()) as TokenBody;

    expect(res.status).toBe(200);
    expect(payload.mission_id).toMatch(/^msn_/);
    expect(payload.expires_in).toBe(900);
    expect(payload.proxy_origins.linear).toContain("127.0.0.1");
    expect(payload.proxy_origins.github).toContain("127.0.0.1");

    const claims = verifyMissionToken(payload.access_token, {
      key: SIGNING_KEY,
    });
    expect(claims.id).toBe(payload.mission_id);
    expect(claims.actor).toBe("ops@local");
    expect(claims.purpose).toBe("support case 42");
    expect(claims.scope).toEqual({ customer: "acme" });
    expect(claims.connections).toEqual(["linear"]);
  });

  it("derives both connections from a customer plus explicit repos", async () => {
    const { base } = await boot();
    const res = await post(
      base,
      "/v1/token",
      mintPayload({ scope: { customer: "acme", repos: ["octo/tool"] } }),
    );
    const payload = (await res.json()) as TokenBody;
    const claims = verifyMissionToken(payload.access_token, {
      key: SIGNING_KEY,
    });

    expect(res.status).toBe(200);
    expect(claims.connections).toEqual(["linear", "github"]);
  });

  it("rejects a bad operator key with 401, mints nothing, echoes no key", async () => {
    const { base, store } = await boot();
    const res = await post(
      base,
      "/v1/token",
      mintPayload(),
      `Bearer ${randomBytes(32).toString("hex")}`,
    );
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(text).not.toContain(OPERATOR_HEX);
    expect(store.active()).toHaveLength(0);
  });

  it("rejects a missing Authorization header with 401", async () => {
    const { base, store } = await boot();
    const res = await fetch(`${base}/v1/token`, {
      method: "POST",
      body: mintPayload(),
    });

    expect(res.status).toBe(401);
    expect(store.active()).toHaveLength(0);
  });

  it("names the offending field on a validation error", async () => {
    const { base, store } = await boot();
    const cases: [Record<string, unknown>, string][] = [
      [{ purpose: "" }, "purpose"],
      [{ actor: "  " }, "actor"],
      [{ ttl: 7200 }, "ttl"],
      [{ ttl: "30m" }, "ttl"],
      [{ scope: {} }, "scope"],
      [{ type: "other" }, "authorization_details"],
    ];
    for (const [over, field] of cases) {
      const res = await post(base, "/v1/token", mintPayload(over));
      const payload = (await res.json()) as { error: { field: string } };
      expect(res.status).toBe(400);
      expect(payload.error.field).toBe(field);
    }
    expect(store.active()).toHaveLength(0);
  });

  it("rejects a wrong grant_type and a malformed body with 400", async () => {
    const { base } = await boot();
    const wrongGrant = await post(
      base,
      "/v1/token",
      JSON.stringify({ grant_type: "password", authorization_details: [] }),
    );
    const grantPayload = (await wrongGrant.json()) as {
      error: { field: string };
    };
    const malformed = await post(base, "/v1/token", "{not json");

    expect(wrongGrant.status).toBe(400);
    expect(grantPayload.error.field).toBe("grant_type");
    expect(malformed.status).toBe(400);
  });

  it("rejects an unknown entity with 400 naming the entity", async () => {
    const { base, store } = await boot();
    const res = await post(
      base,
      "/v1/token",
      mintPayload({ scope: { customer: "globex" } }),
    );
    const payload = (await res.json()) as {
      error: { field: string; reason: string };
    };

    expect(res.status).toBe(400);
    expect(payload.error.field).toBe("scope");
    expect(payload.error.reason).toContain("customer:globex");
    expect(store.active()).toHaveLength(0);
  });
});
