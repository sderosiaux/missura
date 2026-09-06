import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHomes,
  GITHUB_TOKEN,
  initedHarness,
  ZENDESK_INIT_ENV,
} from "./harness.fixtures";
import {
  approvals,
  childM10,
  childM10Foreign,
  childM10Ungranted,
  handedOver,
  M10_COMMENT_PATH,
  M10_DESTROY,
  M10_EGRESS,
  M10_PARAMS,
  unclockedM10,
  type ProofM10,
  type ProofM10Foreign,
} from "./milestone-m10.fixtures";
import { childM7, type ProofM7 } from "./milestone-m7.fixtures";
import { M8_OPERATION } from "./milestone-m8.fixtures";
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
  execArgv,
  missions,
  proof,
  type Call,
} from "./milestone.fixtures";
import { run } from "./index";

/**
 * The proofs, one describe per milestone, on one rig (`milestone.fixtures`).
 * M5/M6, M7 and M8 live in their own files beside this one; the gap (M9) and
 * the approvals (M10) are here.
 */

afterEach(cleanupHomes);

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
      "github.issue.comment.delete",
      "zendesk.tickets.for_entity",
      "zendesk.ticket.reply",
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

/**
 * THE M10 PROOF: a destroy and an egress wait for a human, and nothing else
 * changes. The child asks; the vendor double sees nothing; the operator —
 * this test, typing `missura approve` — decides, and the record says who.
 * The child comes back with the id and the double sees exactly one DELETE,
 * vault-credentialed, logged under the approval; comes back again and is
 * refused with the double unmoved. A denial runs nothing. The egress inside
 * scope waits too. Another mission's id is the not-found an id that never
 * existed gets. The ungranted destroy is M8's own refusal and leaves no
 * record. The raw DELETE never reaches the catalog.
 */
describe("M10 — destroy and egress run once, after a human, under the agent's own token", () => {
  const ALLOW = ["--allow", M10_DESTROY, "--allow", M10_EGRESS];

  it("202 and poll, approve and run once, deny and run nothing, egress waits, raw DELETE refused", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const running = run(execArgv(servers, "customer:acme", childM10(), ALLOW), h.io);

      // 2. The operator approves the first request, in their own name.
      const first = await handedOver(h, "approval-1");
      expect(calls).toEqual([]);
      const approve = await run(["approve", first, "--actor", "ops@acme.example"], h.io);
      expect(approve.code, h.err.join("\n")).toBe(0);
      expect(calls).toEqual([]);

      // 3. And denies the second.
      const second = await handedOver(h, "approval-2");
      const deny = await run(["deny", second, "--actor", "ops@acme.example"], h.io);
      expect(deny.code, h.err.join("\n")).toBe(0);

      expect((await running).code).toBe(0);
      const p = proof(h) as ProofM10;
      const record = missions(h).at(-1);

      // 1. The request answers 202 with the id and its state, nothing else.
      expect(p.first.status).toBe(202);
      expect(JSON.parse(p.first.body)).toEqual({ id: p.ids.first, state: "pending" });
      expect(JSON.parse(p.pending.body)).toEqual({ id: p.ids.first, state: "pending" });
      expect(events(h)).toContainEqual(
        expect.objectContaining({
          operation: "missura.op",
          action: "destroy",
          decision: "pending",
          viaOperation: M10_DESTROY,
          approvalId: p.ids.first,
          missionId: record?.id,
        }),
      );

      // 2. Approved: exactly one DELETE at the double, the vault's credential.
      expect(JSON.parse(p.approved.body)).toEqual({ id: p.ids.first, state: "approved" });
      expect(p.run.status).toBe(200);
      expect(calls).toEqual([
        {
          method: "DELETE",
          url: expect.stringMatching(new RegExp(`${M10_COMMENT_PATH}$`)) as string,
          body: "",
          authorization: `Bearer ${GITHUB_TOKEN}`,
        },
      ]);
      expect(calls[0]?.authorization).not.toMatch(/msr_/);
      expect(events(h)).toContainEqual(
        expect.objectContaining({
          provider: "github",
          operation: "repos.issues.comments.delete",
          action: "destroy",
          decision: "allow",
          viaOperation: M10_DESTROY,
          missionId: record?.id,
        }),
      );
      expect(events(h)).toContainEqual(
        expect.objectContaining({
          operation: "missura.op",
          decision: "allow",
          approvalId: p.ids.first,
          missionId: record?.id,
        }),
      );
      expect(p.again.status).toBe(403);
      expect(p.again.body).toContain("missura_approval_refused");
      expect(calls).toHaveLength(1);

      // 3. Denied: polled as such, and the re-request runs nothing.
      expect(p.second.status).toBe(202);
      expect(JSON.parse(p.denied.body)).toEqual({ id: p.ids.second, state: "denied" });
      expect(p.runDenied.status).toBe(403);
      expect(p.runDenied.body).toContain("missura_approval_refused");
      expect(calls).toHaveLength(1);

      // 4. The egress, in scope and granted, still waits — nothing reached the double.
      expect(p.zendesk.status).toBe(202);
      expect(JSON.parse(p.zendesk.body)).toEqual({ id: p.ids.zendesk, state: "pending" });
      expect(calls).toHaveLength(1);

      // 7. The raw DELETE is not in the catalog.
      expect(p.raw.status).toBe(403);
      expect(p.raw.body).toContain("missura_operation_not_in_catalog");
      expect(calls).toHaveLength(1);

      // The operator's record: who decided what, and the one consumption.
      expect(approvals(h).map((a) => [a.id, a.decision?.decision, a.decision?.actor, a.consumedAt !== undefined])).toEqual([
        [p.ids.first, "approved", "ops@acme.example", true],
        [p.ids.second, "denied", "ops@acme.example", false],
        [p.ids.zendesk, undefined, undefined, false],
      ]);
      expect(p.mission.operations).toContainEqual({ name: M10_DESTROY, effect: "destroy" });
      expect(p.mission.operations).toContainEqual({ name: M10_EGRESS, effect: "egress" });
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("another mission's approval id is the not-found shape on the poll and on the re-request", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      // 5. Minted under acme on the operator plane, opened and approved there.
      const acme = await mint(h, servers, "customer:acme", [M10_DESTROY]);
      expect(acme.status).toBe(200);
      const github = `http://127.0.0.1:${String((servers.github.address() as AddressInfo).port)}`;
      const opened = await fetch(`${github}/missura/op/${M10_DESTROY}`, {
        method: "POST",
        headers: { authorization: `Bearer ${acme.access_token ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify(M10_PARAMS),
      });
      expect(opened.status).toBe(202);
      const { id } = (await opened.json()) as { id: string };
      expect((await run(["approve", id, "--actor", "ops@acme.example"], h.io)).code).toBe(0);

      h.io.env.MISSURA_FOREIGN_APPROVAL = id;
      const p = await exec<ProofM10Foreign>(h, servers, "customer:zoetis", childM10Foreign(), [
        "--allow",
        M10_DESTROY,
      ]);
      expect(p.polled.status).toBe(404);
      expect(p.never.status).toBe(404);
      expect(unclockedM10(p.polled.body)).toBe(unclockedM10(p.never.body));
      expect(p.polled.body).toContain("missura_approval_unknown");
      expect(p.polled.body).not.toContain(id);
      expect(p.run.status).toBe(404);
      expect(p.run.body).toContain("missura_approval_unknown");
      expect(calls).toEqual([]);
      // Still acme's, still approved, never spent.
      expect(approvals(h).find((a) => a.id === id)).toMatchObject({
        decision: { decision: "approved" },
      });
      expect(approvals(h).find((a) => a.id === id)?.consumedAt).toBeUndefined();
    } finally {
      await servers.close();
    }
  }, 30_000);

  it("the same destroy without --allow is M8's refusal, and no approval is recorded", async () => {
    const h = await initedHarness(ZENDESK_INIT_ENV);
    const calls: Call[] = [];
    const servers = await boot(h, calls);

    try {
      const p = await exec<{ first: { status: number; body: string } }>(
        h,
        servers,
        "customer:acme",
        childM10Ungranted(),
      );
      // 6. The allow denial, naming the grant that would open it.
      expect(p.first.status).toBe(403);
      expect(p.first.body).toContain("missura_action_not_allowed");
      expect(p.first.body).toContain(M10_DESTROY);
      expect(calls).toEqual([]);
      expect(approvals(h)).toEqual([]);
    } finally {
      await servers.close();
    }
  }, 30_000);
});
