import { readFileSync, statSync } from "node:fs";
import { MAX_APPROVAL_BYTES, MAX_PENDING_APPROVALS_PER_MISSION } from "@missura/core";
import { describe, expect, it } from "vitest";
import { approvalRig, opened, REPLY_OP, REPLY_PARAMS, requestOp } from "./approvals.fixtures";
import { handle } from "./pipeline";
import { bodyText, graphqlDenial, request, restDenial } from "./pipeline.fixtures";

/**
 * THE EGRESS (M10): `zendesk.ticket.reply` inside scope, granted, still
 * waits — the destination is outside by definition. And when it runs, it
 * runs as a Zendesk write must: the ticket is proven through itself first,
 * and the PUT leaves only once the proof held. A ticket the mission does not
 * cover costs the probe and never the write.
 */

function ticket(id: string, organization: number): string {
  return JSON.stringify({ ticket: { id: Number(id), organization_id: organization, status: "open" } });
}

/** The vendor double: ticket 35 is the mission's, ticket 77 is someone else's. */
function zendesk(url: string, init: RequestInit): Promise<Response> {
  const id = /\/api\/v2\/tickets\/(\d+)/.exec(url)?.[1] ?? "0";
  const organization = id === "35" ? 4200 : 9999;
  const body = init.method === "PUT" ? ticket(id, organization) : ticket(id, organization);
  return Promise.resolve(
    new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  );
}

describe("an egress waits for a human — zendesk.ticket.reply through the executor", () => {
  /**
   * The ticket is proven at request time (M2): a Zendesk ticket's owner is
   * only knowable through the ticket, so the one read the mission already
   * holds runs BEFORE anything is written down. Zero vendor writes — not
   * zero vendor calls.
   */
  it("answers 202 for a ticket in scope after proving it, and nothing is written at the vendor", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const res = await requestOp(rig, REPLY_OP, REPLY_PARAMS);
    expect(res.status).toBe(202);
    expect(rig.connector.calls.map((c) => [c.init.method ?? "GET", c.url])).toEqual([
      ["GET", "https://acme.zendesk.com/api/v2/tickets/35"],
    ]);
    expect(rig.outer.events).toEqual([
      expect.objectContaining({ action: "egress", decision: "pending", viaOperation: REPLY_OP }),
    ]);
  });

  /**
   * PoC A, inverted: a ticket outside the mission answered `202` and left an
   * approval behind, so the human was asked to approve a target that was not
   * theirs — and became the ownership oracle. Now the probe refuses it at
   * request time, not-found shaped, and no record exists.
   */
  it("refuses a foreign ticket at request time, not-found shaped, with no approval left behind", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const res = await requestOp(rig, REPLY_OP, { ...REPLY_PARAMS, ticket: 77 });
    expect(res.status).toBe(404);
    expect(JSON.parse(bodyText(res.body))).toMatchObject({ error: "RecordNotFound" });
    expect(bodyText(res.body)).not.toContain("77");
    expect(rig.connector.calls.map((c) => c.init.method ?? "GET")).toEqual(["GET"]);
    expect(rig.store.pendingApprovals()).toEqual([]);
    expect(rig.outer.events.at(-1)).toMatchObject({ decision: "deny", viaOperation: REPLY_OP });
  });

  it("once approved, proves the ticket then writes the public comment, credentialed by the vault", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const id = await opened(rig, REPLY_OP, REPLY_PARAMS);
    rig.store.decideApproval(id, "approved", "ops@acme.io");

    const res = await requestOp(rig, REPLY_OP, { ...REPLY_PARAMS, approval: id });
    expect(res.status).toBe(200);
    // Proven when opened, proven AGAIN right before the write — never from
    // the memo (L5) — then the PUT.
    expect(rig.connector.calls.map((c) => [c.init.method ?? "GET", c.url])).toEqual([
      ["GET", "https://acme.zendesk.com/api/v2/tickets/35"],
      ["GET", "https://acme.zendesk.com/api/v2/tickets/35"],
      ["PUT", "https://acme.zendesk.com/api/v2/tickets/35"],
    ]);
    const put = rig.connector.calls[2];
    expect(put?.init.body).toBe(
      '{"ticket":{"comment":{"body":"Thanks — we are on it.","public":true}}}',
    );
    expect(new Headers(put?.init.headers).get("authorization")).toBe(
      rig.connector.deps.vendorAuthHeader(),
    );
    expect(rig.connector.events).toContainEqual(
      expect.objectContaining({
        operation: "tickets.update",
        action: "egress",
        decision: "allow",
        viaOperation: REPLY_OP,
      }),
    );
    expect(rig.outer.events.at(-1)).toMatchObject({ decision: "allow", approvalId: id });
  });

  it("never writes on a ticket outside the mission, even under an approval written for it", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    // Written down behind the executor's back — the store does not prove
    // targets, the executor does, and it must do so again at execution.
    const { id } = rig.store.requestApproval(rig.claims.id, {
      operation: REPLY_OP,
      connector: "zendesk",
      effect: "egress",
      params: { ...REPLY_PARAMS, ticket: 77 },
      planned: [
        {
          method: "PUT",
          path: "/api/v2/tickets/77",
          body: '{"ticket":{"comment":{"body":"Thanks — we are on it.","public":true}}}',
        },
      ],
    });
    rig.store.decideApproval(id, "approved", "ops@acme.io");

    const res = await requestOp(rig, REPLY_OP, { ...REPLY_PARAMS, ticket: 77, approval: id });
    expect(res.status).toBe(404);
    expect(JSON.parse(bodyText(res.body))).toMatchObject({ error: "RecordNotFound" });
    expect(rig.connector.calls.map((c) => c.init.method ?? "GET")).toEqual(["GET"]);
  });

  /**
   * H1: one pending approval per target. A second request on the same
   * ticket with another wording is refused, naming the one already waiting —
   * it is not recorded, and the human never sees two rows for one target.
   */
  it("refuses a second pending approval on the same ticket, naming the first, and records nothing", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const id = await opened(rig, REPLY_OP, REPLY_PARAMS);
    const res = await requestOp(rig, REPLY_OP, { ...REPLY_PARAMS, body: "another wording" });

    expect(res.status).toBe(409);
    const denial = graphqlDenial(res.body);
    expect(denial.code).toBe("missura_approval_not_opened");
    expect(denial.reason).toContain(id);
    expect(rig.store.pendingApprovals().map((a) => a.id)).toEqual([id]);
    expect(rig.outer.events.at(-1)).toMatchObject({ decision: "deny", viaOperation: REPLY_OP });
  });

  it("caps the pending approvals one mission may hold", async () => {
    // Every ticket is the mission's here: the cap, not the proof, is under test.
    const ours = (url: string): Promise<Response> =>
      Promise.resolve(
        new Response(ticket(/\/tickets\/(\d+)/.exec(url)?.[1] ?? "0", 4200), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const rig = approvalRig("zendesk", { vendor: ours });
    for (let ticket = 1; ticket <= MAX_PENDING_APPROVALS_PER_MISSION; ticket += 1) {
      await opened(rig, REPLY_OP, { ...REPLY_PARAMS, ticket });
    }
    const res = await requestOp(rig, REPLY_OP, { ...REPLY_PARAMS, ticket: 999 });

    expect(res.status).toBe(409);
    expect(graphqlDenial(res.body).code).toBe("missura_approval_not_opened");
    expect(rig.store.pendingApprovals()).toHaveLength(MAX_PENDING_APPROVALS_PER_MISSION);
  });

  /**
   * PoC B (M3): 20 approvals of 512 KiB made a 20 MiB state file that
   * survived a revoke — a DoS on both planes from one valid token, and a
   * body at rest. Now an oversize body is refused unrecorded, and what is
   * recorded is sealed: the file never holds the reply in the clear.
   */
  it("refuses a body over MAX_APPROVAL_BYTES unrecorded, and seals the ones it records", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const file = (rig.store as unknown as { stateFile: string }).stateFile;
    const blob = "x".repeat(512 * 1024);
    for (let i = 0; i < 3; i += 1) {
      const res = await requestOp(rig, REPLY_OP, { ticket: 35, body: `${blob}${String(i)}` });
      expect(res.status).toBe(413);
      expect(graphqlDenial(res.body).code).toBe("missura_approval_not_opened");
    }
    expect(rig.store.pendingApprovals()).toEqual([]);
    expect(statSync(file).size).toBeLessThan(MAX_APPROVAL_BYTES);

    const id = await opened(rig, REPLY_OP, REPLY_PARAMS);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain(id);
    expect(raw).not.toContain("Thanks");
    expect(raw).not.toContain("xxxx");
  });

  /**
   * PoC F (L5): the read path memoizes a ticket's proof for the mission, and
   * the reply shares the proof key. Read the comments (proof memoized), get
   * the reply approved, move the ticket to another organization at the
   * vendor, re-POST: the PUT left, and the customer got the comment. A
   * write never reuses a memoized proof — it re-probes right before it
   * leaves, and refuses when the proof no longer holds.
   */
  it("re-proves the ticket at execution: a ticket that moved organization since the read gets no PUT", async () => {
    let organization = 4200;
    const vendor = (url: string): Promise<Response> => {
      const id = /\/api\/v2\/tickets\/(\d+)/.exec(url)?.[1] ?? "0";
      const body = url.endsWith("/comments")
        ? JSON.stringify({ comments: [] })
        : JSON.stringify({ ticket: { id: Number(id), organization_id: organization } });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    };
    const rig = approvalRig("zendesk", { vendor });
    // 1. A raw read of the ticket's comments: the probe runs, `ticket:35` is memoized.
    const read = await handle(rig.connector.deps, request({ method: "GET", path: "/api/v2/tickets/35/comments" }));
    expect(read.status).toBe(200);
    // 2. The approval is opened and approved while the ticket is the mission's.
    const id = await opened(rig, REPLY_OP, REPLY_PARAMS);
    rig.store.decideApproval(id, "approved", "ops@acme.io");
    // 3. The ticket moves to another organization at the vendor.
    organization = 9999;
    const res = await requestOp(rig, REPLY_OP, { ...REPLY_PARAMS, approval: id });

    const calls = rig.connector.calls.map(
      (c) => `${c.init.method ?? "GET"} ${c.url.replace("https://acme.zendesk.com", "")}`,
    );
    expect(calls).not.toContain("PUT /api/v2/tickets/35");
    expect(calls.slice(-2)).toEqual(["GET /api/v2/tickets/35", "GET /api/v2/tickets/35"]);
    expect(res.status).toBe(404);
    expect(JSON.parse(bodyText(res.body))).toMatchObject({ error: "RecordNotFound" });
  });

  it("never writes on the raw path: the agent's own PUT is not in the catalog", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const res = await handle(
      rig.connector.deps,
      request({
        method: "PUT",
        path: "/api/v2/tickets/35",
        body: '{"ticket":{"comment":{"body":"straight to the vendor","public":true}}}',
      }),
    );
    expect(res.status).toBe(403);
    expect(restDenial(res.body).code).toBe("missura_operation_not_in_catalog");
    expect(rig.connector.fetchCount()).toBe(0);
  });
});
