import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHomes,
  GITHUB_TOKEN,
  initedHarness,
  LINEAR_KEY,
  ZENDESK_EMAIL,
  ZENDESK_INIT_ENV,
  ZENDESK_TOKEN,
} from "./harness.fixtures";
import {
  boot,
  childM5,
  events,
  exec,
  missions,
  type Call,
} from "./milestone.fixtures";

/**
 * THE M5 PROOF, end to end and through the CLI a human actually types.
 *
 *   missura exec --entity customer:acme --ttl 30m -- <cmd>
 *
 * resolves through the ENTITY GRAPH — not a flat map, not a `customer:` prefix
 * glued onto a name — and the child it spawns reaches every system a human
 * confirmed for that entity, on all three connectors, holding no vendor
 * credential of any kind.
 *
 * And the other half, which is the one the graph exists for: an entity whose
 * Linear link is only PROPOSED mints a mission WITHOUT Linear, that says so.
 * The mission is narrower, it is not refused, and the reason is on the record
 * by name — a bad inference costs reach, never somebody else's data.
 */

interface Proof {
  holdsToken: boolean;
  holdsVendorKeys: string[];
  linear: number;
  github: number;
  zendesk: number;
  mission: Record<string, unknown>;
}

afterEach(cleanupHomes);

describe("M5 — one entity key, every confirmed system, through the graph", () => {
  it("reaches linear, github and zendesk under one --entity mission", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const proof = await exec<Proof>(
        h,
        servers,
        "customer:acme",
        childM5("acme-corp/product", "4200"),
      );

      expect(proof.holdsToken).toBe(true);
      // The red line: three vendors reached, no vendor credential in the child.
      expect(proof.holdsVendorKeys).toEqual([]);
      expect(proof.linear).toBe(200);
      expect(proof.github).toBe(200);
      expect(proof.zendesk).toBe(200);

      // Every call carried the graph's confirmed id, none of them the agent's.
      expect(calls).toHaveLength(3);
      expect(calls[0]?.body).toContain("c_18");
      expect(calls[1]?.url).toContain("/repos/acme-corp/product");
      expect(calls[2]?.url).toContain("/api/v2/organizations/4200/tickets");

      // And each one carried its OWN vendor's credential, taken from the vault
      // `missura init` wrote — the Zendesk call in particular, whose whole
      // credential path (subdomain, agent email, API token, Basic header) had
      // no caller before this milestone.
      expect(calls[2]?.authorization).toBe(
        `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`, "utf8").toString("base64")}`,
      );
      expect(calls[1]?.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(calls[0]?.authorization).toBe(LINEAR_KEY);
      // The mission token is the agent's, and it never travels to a vendor.
      const missionToken = readFileSync(join(h.home, "proof.json"), "utf8");
      expect(missionToken).not.toContain(ZENDESK_TOKEN);
      for (const call of calls) expect(call.authorization).not.toMatch(/msr_/);
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("mints without Linear when its link is only proposed, and records why", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const proof = await exec<Proof>(
        h,
        servers,
        "customer:zoetis",
        childM5("acme-corp/zoetis", "4300"),
      );

      // The two confirmed systems are reached; Linear is refused on the
      // connection check, before anything is asked of the vendor.
      expect(proof.github).toBe(200);
      expect(proof.zendesk).toBe(200);
      expect(proof.linear).toBe(403);
      expect(calls.map((c) => c.url).some((u) => u.includes("graphql"))).toBe(
        false,
      );

      // And it says so, by name, on the mission the operator can read back.
      const record = missions(h).at(-1);
      expect(record?.scope.entity).toBe("customer:zoetis");
      expect(record?.resolution?.entityKey).toBe("customer:zoetis");
      expect(record?.resolution?.degraded).toEqual([
        { system: "linear", reason: "link_proposed", id: "c_77" },
      ]);
    } finally {
      await servers.close();
    }
  }, 30_000);
});

/**
 * THE M6 PROOF: the same narrow mission, asked by the agent itself. It learns
 * that Linear is out and WHY — and not which Linear customer somebody proposed.
 * The record above holds `c_77`; the agent's answer must not, whatever path it
 * took to get there: token, proxy, or the bytes on the wire.
 */
describe("M6 — the agent can ask what it is, and is told what it is not", () => {
  it("names the degraded system by reason class, and never by the proposed id", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const servers = await boot(h, []);

    try {
      const { mission } = await exec<Proof>(
        h,
        servers,
        "customer:zoetis",
        childM5("acme-corp/zoetis", "4300"),
      );

      expect(mission).toMatchObject({
        entity: "customer:zoetis",
        purpose: "m5 proof",
        allow: ["read", "search"],
        systems: ["github", "zendesk"],
        degraded: [{ system: "linear", reason: "link_proposed" }],
      });
      expect(Object.keys(mission).sort()).toEqual([
        "actor",
        "allow",
        "degraded",
        "entity",
        "expires_in",
        "operations",
        "purpose",
        "systems",
      ]);
      expect(JSON.stringify(mission)).not.toContain("c_77");
    } finally {
      await servers.close();
    }
  }, 30_000);
});

/**
 * THE M7 PROOF: missura executing an operation is not missura bypassing
 * itself. The child asks for the entity's tickets by NAME, and the vendor
 * double sees the very call the raw path makes — same org-scoped route, same
 * vault credential — with the decision log naming both. A mission that lacks
 * Linear asking for the Linear operation gets the raw GraphQL refusal, byte
 * for byte, and is never told the operation exists.
 */
interface Answer {
  status: number;
  body: string;
  headers: Record<string, string | null>;
}

interface ProofM7 {
  raw: Answer;
  op: Answer;
  linearOp: Answer;
  linearRaw: Answer;
  mission: { operations: { name: string; effect: string }[] };
}

/** The same ticket list, asked raw and asked as an operation; then Linear both ways. */
function childM7(organization: string): string {
  return `
const fs = require("node:fs");
const auth = { authorization: "Bearer " + process.env.MISSION_TOKEN };
const call = async (url, init) => {
  const r = await fetch(url, init);
  return {
    status: r.status,
    body: await r.text(),
    headers: {
      "content-type": r.headers.get("content-type"),
      "missura-reduced": r.headers.get("missura-reduced"),
    },
  };
};
(async () => {
  const zd = process.env.ZENDESK_API_URL;
  const out = {
    raw: await call(zd + "/api/v2/organizations/${organization}/tickets.json", { headers: auth }),
    op: await call(zd + "/missura/op/zendesk.tickets.for_entity", { method: "POST", headers: auth }),
    linearOp: await call(process.env.GITHUB_API_URL + "/missura/op/linear.issues.for_entity", {
      method: "POST",
      headers: auth,
    }),
    linearRaw: await call(process.env.LINEAR_API_URL, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ query: "{ issues { nodes { id } } }" }),
    }),
    mission: await (await fetch(process.env.MISSURA_MISSION_URL, { headers: auth })).json(),
  };
  fs.writeFileSync(process.env.MISSURA_HOME + "/proof.json", JSON.stringify(out));
})();
`;
}

/** A refusal body with its clock taken out, and the clock on its own. */
function unclocked(body: string): { rest: string; expiresIn: number } {
  const parsed = JSON.parse(body) as {
    errors: { extensions: { missura: { mission: { expires_in: number } } } }[];
  };
  const mission = parsed.errors[0]?.extensions.missura.mission;
  if (mission === undefined) throw new Error("no missura block in the refusal");
  const expiresIn = mission.expires_in;
  mission.expires_in = 0;
  return { rest: JSON.stringify(parsed), expiresIn };
}

describe("M7 — an operation runs through the same pipeline as a raw call", () => {
  it("asks the vendor exactly what the raw path asks, and logs it under the operation", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const proof = await exec<ProofM7>(h, servers, "customer:acme", childM7("4200"));

      expect(proof.raw.status).toBe(200);
      expect(proof.op.status).toBe(200);
      expect(JSON.parse(proof.op.body)).toEqual({
        operation: "zendesk.tickets.for_entity",
        effect: "read",
        results: [{ tickets: [] }],
      });

      // 1. The vendor double received the raw call and the operation's inner
      // call as the SAME call: org-scoped route, vault credential, no token.
      const [raw, inner] = calls;
      expect(inner).toEqual(raw);
      expect(inner?.url).toContain("/api/v2/organizations/4200/tickets");
      expect(inner?.authorization).toBe(
        `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`, "utf8").toString("base64")}`,
      );
      expect(inner?.authorization).not.toMatch(/msr_/);

      // 2. The inner call is a decision of its own, attributed to the mission
      // and naming the operation it served — beside the route it cost.
      const record = missions(h).at(-1);
      const served = events(h).filter(
        (ev) => ev.viaOperation === "zendesk.tickets.for_entity",
      );
      expect(served).toContainEqual(
        expect.objectContaining({
          provider: "zendesk",
          operation: "organizations.tickets.list",
          action: "read",
          decision: "allow",
          missionId: record?.id,
        }),
      );

      // 4. Introspection lists the three operations this whole mission runs.
      expect(proof.mission.operations).toEqual([
        { name: "linear.issues.for_entity", effect: "read" },
        { name: "github.issues.for_entity", effect: "read" },
        { name: "zendesk.tickets.for_entity", effect: "read" },
      ]);
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("refuses an operation on a degraded connector with the raw call's own bytes", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const proof = await exec<ProofM7>(h, servers, "customer:zoetis", childM7("4300"));

      // 3. Status, body and the missura-relevant headers, equal. The clock is
      // the one field two calls a moment apart may not share.
      expect(proof.linearOp.status).toBe(403);
      expect(proof.linearOp.status).toBe(proof.linearRaw.status);
      expect(proof.linearOp.headers).toEqual(proof.linearRaw.headers);
      const op = unclocked(proof.linearOp.body);
      const raw = unclocked(proof.linearRaw.body);
      expect(op.rest).toBe(raw.rest);
      expect(Math.abs(op.expiresIn - raw.expiresIn)).toBeLessThanOrEqual(1);
      expect(proof.linearOp.body).toContain("missura_connection_not_in_mission");
      expect(calls.map((c) => c.url).some((u) => u.includes("graphql"))).toBe(false);

      // 4. Two operations listed, and the Linear one is not named anywhere.
      expect(proof.mission.operations).toHaveLength(2);
      expect(JSON.stringify(proof.mission.operations)).not.toContain("linear");
    } finally {
      await servers.close();
    }
  }, 30_000);
});
