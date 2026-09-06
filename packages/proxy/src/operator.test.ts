import { randomBytes } from "node:crypto";
import { verifyMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_OPERATOR_PORT } from "./operator";
import {
  boot,
  closeAll,
  mintPayload,
  OPERATOR_BEARER,
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
    expect(claims.scope).toEqual({ entity: "customer:acme" });
    // Both, from the RESOLVED scope: the entity `customer:acme` maps a linear
    // customer AND a repo, and the token grants what the scope resolves to.
    expect(claims.connections).toEqual(["linear", "github"]);
  });

  it("derives both connections from a customer plus explicit repos", async () => {
    const { base } = await boot();
    const res = await post(
      base,
      "/v1/token",
      mintPayload({ scope: { entity: "customer:acme", repos: ["octo/tool"] } }),
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
      mintPayload({ scope: { entity: "customer:globex" } }),
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

/**
 * THE M8 GRANT, on the operator plane: `allow` lists operation NAMES to add
 * to the read verbs. Validated against the catalogue the store was built
 * with, so a typo is a named 400 rather than a mission that refuses the one
 * thing it was minted for.
 */
describe("operator API — POST /v1/token with allow", () => {
  it("adds a catalogued write by name to the token", async () => {
    const { base } = await boot();
    const res = await post(
      base,
      "/v1/token",
      mintPayload({ allow: ["github.issue.comment.create"] }),
    );
    const payload = (await res.json()) as TokenBody;
    const claims = verifyMissionToken(payload.access_token, { key: SIGNING_KEY });

    expect(res.status).toBe(200);
    expect(claims.allow).toEqual(["read", "search", "github.issue.comment.create"]);
  });

  it("refuses an unknown name on the `allow` field, naming it, and mints nothing", async () => {
    const { base, store } = await boot();
    const res = await post(
      base,
      "/v1/token",
      mintPayload({ allow: ["github.issue.coment.create"] }),
    );
    const payload = (await res.json()) as { error: { field: string; reason: string } };

    expect(res.status).toBe(400);
    expect(payload.error.field).toBe("allow");
    expect(payload.error.reason).toContain("github.issue.coment.create");
    expect(store.active()).toHaveLength(0);
  });

  /**
   * M9: a name the catalogue holds but the entity cannot run is refused as
   * the GAP — cause, system, remediation — under the `allow` field, so the
   * 400 says what to do next rather than "unknown operation".
   */
  it("refuses a grant the entity cannot run with the gap under `allow`, and mints nothing", async () => {
    const { base, store } = await boot();
    const res = await post(
      base,
      "/v1/token",
      mintPayload({
        scope: { entity: "customer:initech" },
        allow: ["github.issue.comment.create"],
      }),
    );
    const payload = (await res.json()) as {
      error: { field: string; reason: string; gap: Record<string, unknown> };
    };

    expect(res.status).toBe(400);
    expect(payload.error.field).toBe("allow");
    expect(payload.error.gap).toMatchObject({
      name: "github.issue.comment.create",
      cause: "no_link",
      system: "github",
    });
    expect(payload.error.reason).toContain("missura entity link customer:initech github");
    expect(store.active()).toHaveLength(0);
  });

  it("refuses an `allow` that is not a list of strings", async () => {
    const { base, store } = await boot();
    for (const allow of ["github.issue.comment.create", [7], { name: "x" }]) {
      const res = await post(base, "/v1/token", mintPayload({ allow }));
      const payload = (await res.json()) as { error: { field: string } };
      expect(res.status).toBe(400);
      expect(payload.error.field).toBe("allow");
    }
    expect(store.active()).toHaveLength(0);
  });
});

/**
 * THE GAP REPORT on the operator plane (M9): what an entity can run now and,
 * for everything else, the one cause and the command that closes it.
 * Operator-key authenticated like the mint — it names systems, statuses and
 * commands, which is the operator's view and nobody else's.
 */
describe("operator API — GET /v1/feasibility", () => {
  it("reports possible operations and each gap with its cause, for the names asked", async () => {
    const { base } = await boot();
    const res = await fetch(
      `${base}/v1/feasibility?entity=customer:initech&allow=github.issue.comment.create`,
      { headers: { authorization: OPERATOR_BEARER } },
    );
    const payload = (await res.json()) as {
      entity: string;
      operations: { name: string; possible: boolean; cause?: string; system: string; status?: string }[];
    };

    expect(res.status).toBe(200);
    expect(payload.entity).toBe("customer:initech");
    expect(payload.operations.find((op) => op.name === "linear.issues.for_entity")).toMatchObject({
      possible: false,
      cause: "link_not_confirmed",
      system: "linear",
      status: "proposed",
    });
    expect(payload.operations.find((op) => op.name === "github.issue.comment.create")).toMatchObject({
      possible: false,
      cause: "no_link",
      system: "github",
    });
    // Booted without Zendesk: the first cause, whatever the graph says.
    expect(payload.operations.find((op) => op.name === "zendesk.tickets.for_entity")).toMatchObject({
      possible: false,
      cause: "system_not_connected",
    });
  });

  it("marks a write not_granted when the names asked leave it out", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/feasibility?entity=customer:acme`, {
      headers: { authorization: OPERATOR_BEARER },
    });
    const payload = (await res.json()) as {
      operations: { name: string; possible: boolean; cause?: string }[];
    };

    expect(res.status).toBe(200);
    expect(payload.operations.find((op) => op.name === "github.issue.comment.create")).toMatchObject({
      possible: false,
      cause: "not_granted",
    });
    expect(payload.operations.find((op) => op.name === "github.issues.for_entity")).toMatchObject({
      possible: true,
    });
  });

  it("names the entity field on a missing, malformed or unknown entity", async () => {
    const { base } = await boot();
    for (const query of ["", "?entity=acme", "?entity=customer:globex"]) {
      const res = await fetch(`${base}/v1/feasibility${query}`, {
        headers: { authorization: OPERATOR_BEARER },
      });
      const payload = (await res.json()) as { error: { field: string } };
      expect(res.status, query).toBe(400);
      expect(payload.error.field, query).toBe("entity");
    }
  });

  it("checks the operator key first", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/feasibility?entity=customer:acme`);
    expect(res.status).toBe(401);
  });
});
