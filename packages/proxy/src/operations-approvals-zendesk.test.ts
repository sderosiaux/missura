import { MAX_PENDING_APPROVALS_PER_MISSION } from "@missura/core";
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
  it("answers 202 for a ticket in scope, and nothing reaches the vendor — not even the probe", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const res = await requestOp(rig, REPLY_OP, REPLY_PARAMS);
    expect(res.status).toBe(202);
    expect(rig.connector.fetchCount()).toBe(0);
    expect(rig.outer.events).toEqual([
      expect.objectContaining({ action: "egress", decision: "pending", viaOperation: REPLY_OP }),
    ]);
  });

  it("once approved, proves the ticket then writes the public comment, credentialed by the vault", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const id = await opened(rig, REPLY_OP, REPLY_PARAMS);
    rig.store.decideApproval(id, "approved", "ops@acme.io");

    const res = await requestOp(rig, REPLY_OP, { ...REPLY_PARAMS, approval: id });
    expect(res.status).toBe(200);
    expect(rig.connector.calls.map((c) => [c.init.method ?? "GET", c.url])).toEqual([
      ["GET", "https://acme.zendesk.com/api/v2/tickets/35"],
      ["PUT", "https://acme.zendesk.com/api/v2/tickets/35"],
    ]);
    const put = rig.connector.calls[1];
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

  it("never writes on a ticket outside the mission: the probe refuses it, not-found shaped", async () => {
    const rig = approvalRig("zendesk", { vendor: zendesk });
    const id = await opened(rig, REPLY_OP, { ...REPLY_PARAMS, ticket: 77 });
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
    const rig = approvalRig("zendesk", { vendor: zendesk });
    for (let ticket = 1; ticket <= MAX_PENDING_APPROVALS_PER_MISSION; ticket += 1) {
      await opened(rig, REPLY_OP, { ...REPLY_PARAMS, ticket });
    }
    const res = await requestOp(rig, REPLY_OP, { ...REPLY_PARAMS, ticket: 999 });

    expect(res.status).toBe(409);
    expect(graphqlDenial(res.body).code).toBe("missura_approval_not_opened");
    expect(rig.store.pendingApprovals()).toHaveLength(MAX_PENDING_APPROVALS_PER_MISSION);
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
