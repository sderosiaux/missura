import { approvalState, type ApprovalRecord } from "@missura/core";
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

function pending(h: Harness): ApprovalRecord {
  const store = openStore(resolveHome(h.io.env), operationCatalogue({ zendesk: false }));
  const { record } = store.create(
    {
      purpose: "m10 spec",
      actor: "sam@acme.io",
      scope: { repos: ["acme-corp/product"] },
      ttlSeconds: 900,
      allow: [REQUEST.operation],
    },
    { githubRepos: [{ repo: "acme-corp/product" }] },
  );
  return store.requestApproval(record.id, REQUEST);
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

  it("prints the whole record as JSON, parameters and body included", async () => {
    const h = await initedHarness();
    const approval = pending(h);
    h.out.length = 0;
    const result = await run(["approvals", "--json"], h.io);
    expect(result.code).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ approvals: [approval] });
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
