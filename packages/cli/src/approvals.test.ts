import { approvalState, type ApprovalRecord, type ApprovalRequest } from "@missura/core";
import { operationCatalogue } from "@missura/proxy";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHomes, initedHarness, type Harness } from "./harness.fixtures";
import { run } from "./index";
import { openStore } from "./missions";
import { resolveHome } from "./paths";

/**
 * `missura approvals` / `approve` / `deny` — the operator's side of an
 * approval (M10), on the same state file the proxy writes. Listing shows
 * the planned call in full: this is the operator, who may see everything.
 * Deciding records a name and a time and runs nothing — there is nothing
 * in this process that could.
 */

const REQUEST = {
  operation: "github.issue.comment.delete",
  params: { repo: "acme-corp/product", comment: 9001 },
  planned: [
    { method: "DELETE", path: "/repos/acme-corp/product/issues/comments/9001", body: "" },
  ],
};

/** The egress: the reply text is what leaves, and what the human must read. */
const REPLY_TEXT =
  "Hi Dana, we have refunded the March invoice in full; it lands within 5 business days. Sorry again.";
const REPLY = {
  operation: "zendesk.ticket.reply",
  params: { ticket: 35, body: REPLY_TEXT },
  planned: [
    {
      method: "PUT",
      path: "/api/v2/tickets/35",
      body: JSON.stringify({ ticket: { comment: { body: REPLY_TEXT, public: true } } }),
    },
  ],
};

function pending(h: Harness, request: ApprovalRequest = REQUEST): ApprovalRecord {
  const store = openStore(resolveHome(h.io.env), operationCatalogue({ zendesk: true }));
  const { record } = store.create(
    {
      purpose: "m10 spec",
      actor: "sam@acme.io",
      scope: { repos: ["acme-corp/product"] },
      ttlSeconds: 900,
      allow: [request.operation],
    },
    { githubRepos: [{ repo: "acme-corp/product" }], zendeskOrganizationIds: ["4200"] },
  );
  return store.requestApproval(record.id, request);
}

function recorded(h: Harness, id: string): ApprovalRecord | undefined {
  const store = openStore(resolveHome(h.io.env));
  const held = store.pendingApprovals().find((a) => a.id === id);
  if (held !== undefined) return held;
  // Decided ones are no longer pending; read them back by their mission.
  for (const mission of store.active()) {
    const found = store.approvalFor(mission.id, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

afterEach(cleanupHomes);

describe("missura approvals", () => {
  it("says so when nothing is pending", async () => {
    const h = await initedHarness();
    const result = await run(["approvals"], h.io);
    expect(result.code).toBe(0);
    expect(h.out).toEqual(["no pending approvals"]);
  });

  it("lists each pending approval with its mission, operation and the planned call", async () => {
    const h = await initedHarness();
    const approval = pending(h);
    h.out.length = 0;
    const result = await run(["approvals"], h.io);
    const text = h.out.join("\n");

    expect(result.code).toBe(0);
    expect(h.out[0]).toMatch(/^ID\s+MISSION\s+OPERATION\s+CALL/);
    expect(text).toContain(approval.id);
    expect(text).toContain(approval.missionId);
    expect(text).toContain(REQUEST.operation);
    expect(text).toContain("DELETE /repos/acme-corp/product/issues/comments/9001");
  });

  /**
   * H1: an egress is approved by a human who has read what leaves. The
   * default table carries the body of every non-read call — cut to the
   * column, never dropped — and `--full` prints it whole.
   */
  it("shows the body an egress will send, in the default table", async () => {
    const h = await initedHarness();
    pending(h, REPLY);
    h.out.length = 0;
    const result = await run(["approvals"], h.io);
    const text = h.out.join("\n");

    expect(result.code).toBe(0);
    expect(h.out[0]).toMatch(/^ID\s+MISSION\s+OPERATION\s+CALL\s+BODY\s+AGE/);
    expect(text).toContain("PUT /api/v2/tickets/35");
    expect(text).toContain("Hi Dana, we have refunded");
  });

  it("prints the whole body with --full, and the destroy's empty one as such", async () => {
    const h = await initedHarness();
    const reply = pending(h, REPLY);
    const destroy = pending(h);
    h.out.length = 0;
    const result = await run(["approvals", "--full"], h.io);
    const text = h.out.join("\n");

    expect(result.code).toBe(0);
    expect(text).toContain(reply.id);
    expect(text).toContain(destroy.id);
    expect(text).toContain(REPLY.planned[0]?.body ?? "");
    expect(text).toContain("DELETE /repos/acme-corp/product/issues/comments/9001");
  });

  it("prints the whole record as JSON, parameters and body included, opened", async () => {
    const h = await initedHarness();
    const approval = pending(h);
    h.out.length = 0;
    const result = await run(["approvals", "--json"], h.io);
    expect(result.code).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toEqual({
      approvals: [{ ...approval, sealed: undefined, ...REQUEST }],
    });
  });
});

describe("missura approve / deny", () => {
  it("approve records the actor, says so, and runs nothing", async () => {
    const h = await initedHarness();
    const { id } = pending(h);
    h.out.length = 0;
    const result = await run(["approve", id, "--actor", "ops@acme.example"], h.io);

    expect(result.code).toBe(0);
    expect(h.out).toEqual([`approved ${id} (by ops@acme.example)`]);
    const record = recorded(h, id);
    expect(record === undefined ? undefined : approvalState(record)).toBe("approved");
    expect(record?.decision?.actor).toBe("ops@acme.example");
    expect(record?.consumedAt).toBeUndefined();
  });

  it("deny records the same way, and the actor defaults to the shell user", async () => {
    const h = await initedHarness({ USER: "sam" });
    const { id } = pending(h);
    h.out.length = 0;
    const result = await run(["deny", id], h.io);

    expect(result.code).toBe(0);
    expect(h.out).toEqual([`denied ${id} (by sam@local)`]);
    const record = recorded(h, id);
    expect(record === undefined ? undefined : approvalState(record)).toBe("denied");
  });

  it("refuses a missing id, an unknown id, and a second decision", async () => {
    const h = await initedHarness();
    const { id } = pending(h);
    const missing = await run(["approve"], h.io);
    expect(missing.code).toBe(1);
    expect(h.err[0] ?? "").toContain("missura approvals");

    h.err.length = 0;
    const unknown = await run(["deny", "apr_0000000000000000"], h.io);
    expect(unknown.code).toBe(1);
    expect(h.err[0] ?? "").toContain("unknown approval");

    await run(["deny", id], h.io);
    h.err.length = 0;
    const twice = await run(["approve", id], h.io);
    expect(twice.code).toBe(1);
    expect(h.err[0] ?? "").toContain("already denied");
  });
});
