import { approvalState } from "@missura/core";
import { describe, expect, it } from "vitest";
import {
  approvalRig,
  COMMENT_PATH,
  DELETE_OP,
  DELETE_PARAMS,
  opened,
  poll,
  requestOp,
} from "./approvals.fixtures";
import { result } from "./operations.fixtures";
import { handle } from "./pipeline";
import { bodyText, graphqlDenial, request, restDenial } from "./pipeline.fixtures";

/**
 * THE M10 PROPERTY: a `destroy` never runs on request. It is proven exactly
 * as M8 proves a write — grant, scope, target, before anything leaves — and
 * then written down on the mission as the exact inner call that would go,
 * answered `202`, and run ONCE when the agent comes back with an approval a
 * human recorded. Deciding is a record, not a run; the run stays on the data
 * plane, under the agent's own token, through the same pipeline.
 */

function unclocked(body: string): string {
  return body.replace(/"expires_in":\d+/, '"expires_in":0');
}

describe("a destroy waits for a human — github.issue.comment.delete through the executor", () => {
  it("answers 202 with the approval id and its state, reaches no vendor, and logs pending", async () => {
    const rig = approvalRig("github");
    const res = await requestOp(rig, DELETE_OP, DELETE_PARAMS);

    expect(res.status).toBe(202);
    const body = JSON.parse(bodyText(res.body)) as { id: string; state: string };
    expect(body).toEqual({ id: expect.stringMatching(/^apr_[0-9a-f]{16}$/) as string, state: "pending" });
    expect(rig.connector.fetchCount()).toBe(0);
    // Written down on the mission: what was asked, and the exact call that would go.
    expect(rig.store.approvalFor(rig.claims.id, body.id)).toMatchObject({
      operation: DELETE_OP,
      params: DELETE_PARAMS,
      planned: [{ method: "DELETE", path: COMMENT_PATH, body: "" }],
    });
    expect(rig.outer.events).toEqual([
      expect.objectContaining({
        operation: "missura.op",
        action: "destroy",
        decision: "pending",
        viaOperation: DELETE_OP,
        approvalId: body.id,
        missionId: rig.claims.id,
      }),
    ]);
    // The connector proved the target and ran nothing: no event of its own.
    expect(rig.connector.events).toEqual([]);
  });

  it("polls pending then approved, runs exactly once on the re-request, and never again", async () => {
    const rig = approvalRig("github");
    const id = await opened(rig, DELETE_OP, DELETE_PARAMS);
    expect(JSON.parse((await poll(rig, id)).body)).toEqual({ id, state: "pending" });

    rig.store.decideApproval(id, "approved", "ops@acme.io");
    expect(JSON.parse((await poll(rig, id)).body)).toEqual({ id, state: "approved" });
    expect(rig.connector.fetchCount()).toBe(0);

    const res = await requestOp(rig, DELETE_OP, { ...DELETE_PARAMS, approval: id });
    expect(res.status).toBe(200);
    expect(result(res)).toMatchObject({ operation: DELETE_OP, effect: "destroy" });
    expect(rig.connector.calls).toHaveLength(1);
    const [call] = rig.connector.calls;
    expect(call?.url).toBe(`https://api.github.com${COMMENT_PATH}`);
    expect(call?.init.method).toBe("DELETE");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(rig.connector.deps.vendorAuthHeader());
    expect(headers.get("authorization")).not.toMatch(/msr_/);
    expect(rig.connector.events).toContainEqual(
      expect.objectContaining({
        operation: "repos.issues.comments.delete",
        action: "destroy",
        decision: "allow",
        viaOperation: DELETE_OP,
      }),
    );
    expect(rig.outer.events.at(-1)).toMatchObject({
      operation: "missura.op",
      action: "destroy",
      decision: "allow",
      approvalId: id,
    });
    expect(JSON.parse((await poll(rig, id)).body)).toEqual({ id, state: "consumed" });

    // A consumed approval cannot execute twice.
    const again = await requestOp(rig, DELETE_OP, { ...DELETE_PARAMS, approval: id });
    expect(again.status).toBe(403);
    // In the listener's own envelope (M7): the agent aimed at the linear port.
    expect(graphqlDenial(again.body).code).toBe("missura_approval_refused");
    expect(graphqlDenial(again.body).reason).toContain("consumed");
    expect(rig.connector.calls).toHaveLength(1);
  });

  it("runs nothing on a denied approval, and nothing on one still pending", async () => {
    const rig = approvalRig("github");
    const pending = await opened(rig, DELETE_OP, DELETE_PARAMS);
    const early = await requestOp(rig, DELETE_OP, { ...DELETE_PARAMS, approval: pending });
    expect(early.status).toBe(403);
    expect(graphqlDenial(early.body).reason).toContain("pending");

    rig.store.decideApproval(pending, "denied", "ops@acme.io");
    expect(JSON.parse((await poll(rig, pending)).body)).toEqual({ id: pending, state: "denied" });
    const res = await requestOp(rig, DELETE_OP, { ...DELETE_PARAMS, approval: pending });
    expect(res.status).toBe(403);
    expect(graphqlDenial(res.body).code).toBe("missura_approval_refused");
    expect(graphqlDenial(res.body).reason).toContain("denied");
    expect(rig.connector.fetchCount()).toBe(0);
  });

  it("refuses an approved id on other parameters or another operation, and spends nothing", async () => {
    const rig = approvalRig("github");
    const id = await opened(rig, DELETE_OP, DELETE_PARAMS);
    rig.store.decideApproval(id, "approved", "ops@acme.io");
    const other = await requestOp(rig, DELETE_OP, { ...DELETE_PARAMS, comment: 9002, approval: id });
    expect(other.status).toBe(403);
    expect(graphqlDenial(other.body).code).toBe("missura_approval_refused");

    // An approval opened for another operation, same parameters.
    const foreign = rig.store.requestApproval(rig.claims.id, {
      operation: "zendesk.ticket.reply",
      params: DELETE_PARAMS,
      planned: [{ method: "DELETE", path: COMMENT_PATH, body: "" }],
    });
    rig.store.decideApproval(foreign.id, "approved", "ops@acme.io");
    const wrong = await requestOp(rig, DELETE_OP, { ...DELETE_PARAMS, approval: foreign.id });
    expect(wrong.status).toBe(403);

    expect(rig.connector.fetchCount()).toBe(0);
    for (const spent of [id, foreign.id]) {
      const record = rig.store.approvalFor(rig.claims.id, spent);
      expect(record === undefined ? undefined : approvalState(record)).toBe("approved");
    }
  });

  it("answers another mission's approval id as not-found, on the poll and on the re-request alike", async () => {
    const rig = approvalRig("github");
    const id = await opened(rig, DELETE_OP, DELETE_PARAMS);
    rig.store.decideApproval(id, "approved", "ops@acme.io");
    const other = approvalRig("github", { store: rig.store });

    const theirs = await poll(other, id);
    const never = await poll(other, "apr_0000000000000000");
    expect(theirs.status).toBe(404);
    expect(never.status).toBe(404);
    expect(unclocked(theirs.body)).toBe(unclocked(never.body));
    expect(theirs.body).not.toContain(id);
    expect(graphqlDenial(theirs.body).code).toBe("missura_approval_unknown");

    const res = await requestOp(other, DELETE_OP, { ...DELETE_PARAMS, approval: id });
    expect(res.status).toBe(404);
    expect(graphqlDenial(res.body).code).toBe("missura_approval_unknown");
    expect(other.connector.fetchCount()).toBe(0);
    // Still theirs, still approved, still spendable by the mission it belongs to.
    const record = rig.store.approvalFor(rig.claims.id, id);
    expect(record === undefined ? undefined : approvalState(record)).toBe("approved");
  });

  it("refuses a foreign repository as not-found with zero vendor calls, and records no approval", async () => {
    const rig = approvalRig("github");
    const res = await requestOp(rig, DELETE_OP, { ...DELETE_PARAMS, repo: "globex/secret" });
    expect(res.status).toBe(404);
    expect(restDenial(res.body).code).toBe("missura_out_of_mission_scope");
    expect(JSON.parse(bodyText(res.body))).toMatchObject({ message: "Not Found" });
    expect(rig.connector.fetchCount()).toBe(0);
    expect(rig.store.pendingApprovals()).toEqual([]);
    expect(rig.connector.events).toContainEqual(
      expect.objectContaining({ action: "destroy", decision: "deny", viaOperation: DELETE_OP }),
    );
  });

  it("refuses an ungranted destroy as the allow denial, before anything is recorded", async () => {
    const rig = approvalRig("github", { allow: [] });
    const res = await requestOp(rig, DELETE_OP, DELETE_PARAMS);
    expect(res.status).toBe(403);
    const denial = restDenial(res.body);
    expect(denial.code).toBe("missura_action_not_allowed");
    expect(denial.remediation).toContain(DELETE_OP);
    expect(rig.store.pendingApprovals()).toEqual([]);
    expect(rig.connector.fetchCount()).toBe(0);
  });

  it("never destroys on the raw path: the agent's own DELETE is not in the catalog", async () => {
    const rig = approvalRig("github");
    const res = await handle(
      rig.connector.deps,
      request({ method: "DELETE", path: COMMENT_PATH }),
    );
    expect(res.status).toBe(403);
    expect(restDenial(res.body).code).toBe("missura_operation_not_in_catalog");
    expect(rig.connector.fetchCount()).toBe(0);
  });

  it("refuses an approval that is not a string, as a parameter", async () => {
    const rig = approvalRig("github");
    const res = await requestOp(rig, DELETE_OP, { ...DELETE_PARAMS, approval: 7 });
    expect(res.status).toBe(400);
    expect(rig.connector.fetchCount()).toBe(0);
  });
});
