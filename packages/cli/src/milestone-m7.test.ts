import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHomes,
  initedHarness,
  ZENDESK_EMAIL,
  ZENDESK_INIT_ENV,
  ZENDESK_TOKEN,
} from "./harness.fixtures";
import { childM7, unclocked, type ProofM7 } from "./milestone-m7.fixtures";
import { boot, events, exec, missions, type Call } from "./milestone.fixtures";

afterEach(cleanupHomes);

/**
 * THE M7 PROOF: missura executing an operation is not missura bypassing
 * itself. The child asks for the entity's tickets by NAME, and the vendor
 * double sees the very call the raw path makes — same org-scoped route, same
 * vault credential — with the decision log naming both. A mission that lacks
 * Linear asking for the Linear operation gets the raw GraphQL refusal, byte
 * for byte, and is never told the operation exists.
 */
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
