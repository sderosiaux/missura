import { approvalState, type ApprovalRecord } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { boot, closeAll, mint, OPERATOR_BEARER, post, type Operator } from "./operator.fixtures";

/**
 * THE APPROVAL SURFACE on the operator plane (M10): list what is pending —
 * with the planned call, since the operator may see everything — and record
 * a decision. Deciding executes nothing: this plane holds the operator key
 * and no vendor credential, no pipeline and no fetch, so there is nothing
 * here an approval could run through. The run is the agent's, later, on the
 * data plane.
 */

afterEach(closeAll);

const REQUEST = {
  operation: "github.issue.comment.delete",
  params: { repo: "acme-corp/product", comment: 9001 },
  planned: [
    { method: "DELETE", path: "/repos/acme-corp/product/issues/comments/9001", body: "" },
  ],
};

async function pending(op: Operator): Promise<ApprovalRecord> {
  const { mission_id } = await mint(op.base);
  return op.store.requestApproval(mission_id, REQUEST);
}

async function list(base: string): Promise<{ approvals: ApprovalRecord[] }> {
  const res = await fetch(`${base}/v1/approvals`, { headers: { authorization: OPERATOR_BEARER } });
  expect(res.status).toBe(200);
  return (await res.json()) as { approvals: ApprovalRecord[] };
}

describe("operator API — GET /v1/approvals", () => {
  it("lists the pending approvals with the planned call, and nothing decided", async () => {
    const op = await boot();
    const first = await pending(op);
    const second = await pending(op);
    op.store.decideApproval(second.id, "denied", "ops@local");

    const { approvals } = await list(op.base);
    expect(approvals).toEqual([first]);
    expect(approvals[0]?.planned).toEqual(REQUEST.planned);
  });

  it("checks the operator key first", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/v1/approvals`)).status).toBe(401);
  });
});

describe("operator API — POST /v1/approvals/<id>", () => {
  it("records the decision with its actor, and runs nothing", async () => {
    const op = await boot();
    const { id, missionId } = await pending(op);
    const res = await post(
      op.base,
      `/v1/approvals/${id}`,
      JSON.stringify({ decision: "approved", actor: "ops@acme.io" }),
    );
    const payload = (await res.json()) as { approval: ApprovalRecord };

    expect(res.status).toBe(200);
    expect(payload.approval).toMatchObject({
      id,
      decision: { decision: "approved", actor: "ops@acme.io" },
    });
    const record = op.store.approvalFor(missionId, id);
    expect(record === undefined ? undefined : approvalState(record)).toBe("approved");
    // Nothing consumed it: the record still awaits the agent's own request.
    expect(record?.consumedAt).toBeUndefined();
    expect((await list(op.base)).approvals).toEqual([]);
  });

  it("records a denial the same way", async () => {
    const op = await boot();
    const { id, missionId } = await pending(op);
    const res = await post(op.base, `/v1/approvals/${id}`, JSON.stringify({ decision: "denied", actor: "ops" }));
    expect(res.status).toBe(200);
    const record = op.store.approvalFor(missionId, id);
    expect(record === undefined ? undefined : approvalState(record)).toBe("denied");
  });

  it("names the field on a bad decision, a blank actor, an unknown id and a second decision", async () => {
    const op = await boot();
    const { id } = await pending(op);
    const cases: [string, Record<string, unknown>, string][] = [
      [id, { decision: "maybe", actor: "ops" }, "decision"],
      [id, { decision: "approved" }, "actor"],
      [id, { decision: "approved", actor: "  " }, "actor"],
      ["apr_0000000000000000", { decision: "approved", actor: "ops" }, "id"],
    ];
    for (const [target, body, field] of cases) {
      const res = await post(op.base, `/v1/approvals/${target}`, JSON.stringify(body));
      const payload = (await res.json()) as { error: { field: string } };
      expect(res.status, field).toBe(400);
      expect(payload.error.field, field).toBe(field);
    }
    await post(op.base, `/v1/approvals/${id}`, JSON.stringify({ decision: "denied", actor: "ops" }));
    const twice = await post(op.base, `/v1/approvals/${id}`, JSON.stringify({ decision: "approved", actor: "ops" }));
    const payload = (await twice.json()) as { error: { field: string; reason: string } };
    expect(twice.status).toBe(400);
    expect(payload.error.field).toBe("id");
    expect(payload.error.reason).toContain("already denied");
  });

  it("checks the operator key first", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/approvals/apr_0000000000000000`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", actor: "ops" }),
    });
    expect(res.status).toBe(401);
  });
});
