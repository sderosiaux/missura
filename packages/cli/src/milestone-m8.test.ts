import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHomes,
  GITHUB_TOKEN,
  initedHarness,
  ZENDESK_INIT_ENV,
} from "./harness.fixtures";
import {
  childM8,
  M8_BODY,
  M8_OPERATION,
  restUnclocked,
  type ProofM8,
} from "./milestone-m8.fixtures";
import { boot, events, exec, missions, type Call } from "./milestone.fixtures";

afterEach(cleanupHomes);

/**
 * THE M8 PROOF: the first write, and the two things that make it safe. The
 * child, under a mission that NAMES the operation, posts one comment on the
 * entity's repository — the vendor double sees one POST, vault-credentialed,
 * and the log says append/allow under the operation and the mission. Then
 * the same operation aimed at a foreign repository is refused with the bytes
 * a foreign READ gets, the agent's own POST to the vendor route is refused
 * at the catalog, and the double has seen nothing since the first call:
 * writes happen only through operations, and a write is proven before it
 * happens or it does not happen.
 */
describe("M8 — the first write: proven before, operation-only, on the record", () => {
  it("posts one comment on the mission's repo, refuses the rest before the vendor", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const proof = await exec<ProofM8>(h, servers, "customer:acme", childM8(), [
        "--allow",
        M8_OPERATION,
      ]);

      // 1. One write, and exactly one vendor call: the comments route on the
      // entity's repository, the vault's GitHub credential, the agent's body.
      expect(proof.write.status).toBe(200);
      expect(JSON.parse(proof.write.body)).toEqual({
        operation: M8_OPERATION,
        effect: "append",
        results: [{ id: 9001 }],
      });
      expect(calls).toEqual([
        {
          method: "POST",
          url: expect.stringMatching(/\/repos\/acme-corp\/product\/issues\/7\/comments$/) as string,
          body: JSON.stringify({ body: M8_BODY }),
          authorization: `Bearer ${GITHUB_TOKEN}`,
        },
      ]);
      expect(calls[0]?.authorization).not.toMatch(/msr_/);
      const record = missions(h).at(-1);
      expect(events(h)).toContainEqual(
        expect.objectContaining({
          provider: "github",
          operation: "repos.issues.comments.create",
          action: "append",
          decision: "allow",
          viaOperation: M8_OPERATION,
          missionId: record?.id,
        }),
      );

      // 2. A foreign repository: the not-found a foreign read gets, byte for
      // byte but for the clock — and the double saw nothing further.
      expect(proof.foreign.status).toBe(404);
      expect(proof.foreign.status).toBe(proof.foreignRead.status);
      const foreign = restUnclocked(proof.foreign.body);
      const read = restUnclocked(proof.foreignRead.body);
      expect(foreign.rest).toBe(read.rest);
      expect(Math.abs(foreign.expiresIn - read.expiresIn)).toBeLessThanOrEqual(1);
      expect(proof.foreign.body).toContain('"message":"Not Found"');
      expect(proof.foreign.body).toContain("missura_out_of_mission_scope");

      // 3. THE RAW PATH NEVER WRITES. The agent's own POST, same token, same
      // route the operation just used, is not in the catalog — and no vendor
      // call happened for it. This is the assertion that makes writes
      // operation-only.
      expect(proof.raw.status).toBe(403);
      expect(proof.raw.body).toContain("missura_operation_not_in_catalog");
      expect(calls).toHaveLength(1);

      // 4. Introspection lists the write, by name and effect.
      expect(proof.mission.allow).toEqual(["read", "search", M8_OPERATION]);
      expect(proof.mission.operations).toContainEqual({
        name: M8_OPERATION,
        effect: "append",
      });
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("refuses the write under a mission that does not name it, and never lists it", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const proof = await exec<ProofM8>(h, servers, "customer:acme", childM8());

      expect(proof.write.status).toBe(403);
      expect(proof.write.body).toContain("missura_action_not_allowed");
      expect(proof.foreign.status).toBe(403);
      expect(proof.raw.status).toBe(403);
      expect(calls).toEqual([]);
      expect(proof.mission.allow).toEqual(["read", "search"]);
      expect(JSON.stringify(proof.mission.operations)).not.toContain(M8_OPERATION);
    } finally {
      await servers.close();
    }
  }, 30_000);
});
