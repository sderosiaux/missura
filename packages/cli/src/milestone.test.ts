import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHomes,
  GITHUB_TOKEN,
  initedHarness,
  ZENDESK_EMAIL,
  ZENDESK_INIT_ENV,
  ZENDESK_TOKEN,
} from "./harness.fixtures";
import {
  childM7,
  unclocked,
  type ProofM7,
} from "./milestone-m7.fixtures";
import {
  childM8,
  M8_BODY,
  M8_OPERATION,
  restUnclocked,
  type ProofM8,
} from "./milestone-m8.fixtures";
import {
  feasibility,
  mint,
  operation,
  show,
  systemsNamed,
} from "./milestone-m9.fixtures";
import {
  boot,
  events,
  exec,
  missions,
  type Call,
} from "./milestone.fixtures";
import { run } from "./index";

/**
 * The proofs, one describe per milestone. M5 and M6 — the graph and the
 * agent's introspection of it — live in `milestone-m5.test.ts`, on the same
 * rig; from M7 on, the operations, the write and the gap are here.
 */

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

/**
 * THE M9 PROOF: when something is not possible, the answer is the GAP — the
 * one cause, and the next connection that closes it — computed from the
 * catalogue and the graph, deterministically, with no model anywhere. The
 * operator sees everything: system, link status, the command. The agent sees
 * only what its mission already told it: a reason class, and nothing that
 * names a system outside the mission.
 */
describe("M9 — the gap is specific and actionable, and it names the next connection", () => {
  it("entity show: three possible, and Linear as the one gap with its status and command", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const shown = await show(h, "customer:zoetis");

    expect(shown.operations.filter((op) => op.possible).map((op) => op.name)).toEqual([
      "github.issues.for_entity",
      "github.issue.comment.create",
      "zendesk.tickets.for_entity",
    ]);
    expect(operation(shown, "linear.issues.for_entity")).toMatchObject({
      possible: false,
      cause: "link_not_confirmed",
      system: "linear",
      status: "proposed",
      remediation: expect.stringContaining("missura entity confirm customer:zoetis linear") as string,
    });
  });

  it("no GitHub link: exec --allow fails as the no_link gap, and so does the operator mint", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const servers = await boot(h, []);

    try {
      const code = await run(
        [
          "exec", "--entity", "customer:initech", "--purpose", "m9 proof",
          "--allow", M8_OPERATION, "--", process.execPath, "-e", "0",
        ],
        h.io,
      );
      expect(code.code).toBe(1);
      const message = h.err[0] ?? "";
      expect(message).toContain("no_link");
      expect(message).toContain("github");
      expect(message).toContain("missura entity link customer:initech github");
      expect(message).not.toContain("unknown operation");

      const refused = await mint(h, servers, "customer:initech", [M8_OPERATION]);
      expect(refused.status).toBe(400);
      expect(refused.error.field).toBe("allow");
      expect(refused.error.gap).toMatchObject({ cause: "no_link", system: "github" });
      expect(refused.error.reason).toContain("missura entity link customer:initech github");
      // Nothing was minted by either surface: the store never wrote its file.
      expect(existsSync(join(h.home, "missions.json"))).toBe(false);
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("booted without Zendesk: its operation is system_not_connected for every entity, fixed by missura init", async () => {
    const h = await initedHarness();
    for (const key of ["customer:acme", "customer:zoetis", "customer:initech"]) {
      expect(operation(await show(h, key), "zendesk.tickets.for_entity"), key).toMatchObject({
        possible: false,
        cause: "system_not_connected",
        system: "zendesk",
        remediation: expect.stringContaining("missura init") as string,
      });
    }
    // The operator plane of that same boot answers the same.
    const servers = await boot(h, []);
    try {
      expect(servers.zendesk).toBeUndefined();
      const report = await feasibility(h, servers, "customer:acme");
      expect(operation(report, "zendesk.tickets.for_entity")).toMatchObject({
        cause: "system_not_connected",
      });
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("the agent's refusal carries the reason class, and nothing beyond what its mission says", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const servers = await boot(h, []);

    try {
      const proof = await exec<ProofM7>(h, servers, "customer:zoetis", childM7("4300"));
      const body = proof.linearOp.body;
      const parsed = JSON.parse(body) as {
        errors: { extensions: { missura: { code: string; cause?: string } } }[];
      };
      expect(parsed.errors[0]?.extensions.missura).toMatchObject({
        code: "missura_connection_not_in_mission",
        cause: "link_proposed",
      });

      // No link status word beyond the reason class, no native id.
      const stripped = body.replace(/link_proposed/g, "");
      for (const word of ["proposed", "confirmed", "rejected", "broken", "c_77", "4300", "acme-corp"]) {
        expect(stripped, word).not.toContain(word);
      }
      // No system the mission did not already name: connections ∪ degraded.
      const mission = proof.mission as unknown as {
        systems: string[];
        degraded: { system: string }[];
      };
      const known = new Set([...mission.systems, ...mission.degraded.map((d) => d.system)]);
      for (const system of systemsNamed(body)) expect(known.has(system), system).toBe(true);
    } finally {
      await servers.close();
    }
  }, 30_000);
});
