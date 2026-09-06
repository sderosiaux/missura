import { ZENDESK_OPERATIONS } from "@missura/connectors-zendesk";
import { createParentProofStore, type CatalogDecision, type MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import { NO_APPROVALS } from "./approvals";
import type { NarrowResult } from "./narrow";
import {
  ALLOWED,
  COMMENT_PAGE,
  COMMENTS,
  decideZendeskish,
  FOREIGN,
  json,
  narrowed,
  owned,
  setup,
  TICKET,
  ticket,
  vendorDouble,
  ZENDESK_CLAIMS,
} from "./parent-proof.fixtures";
import { handle } from "./pipeline";
import { harness, request } from "./pipeline.fixtures";

describe("parent proof — a write is never served on a memoized proof", () => {
  /**
   * A WRITE never reuses a memoized proof (L5). The memo is a read-side
   * optimisation whose residual is timing; on a write the same residual is
   * an irreversible call on an object that moved since the proof. So a
   * write re-probes every time, right before it leaves, and a proof that no
   * longer holds refuses it.
   */
  it("re-probes for a write even when the parent is memoized, and refuses when it moved", async () => {
    const proofs = createParentProofStore();
    const first = setup(owned, { proofs });
    await handle(first.deps, request({ path: COMMENTS }));
    expect(proofs.isProven(ZENDESK_CLAIMS.jti, "ticket:35436")).toBe(true);

    const write: CatalogDecision = { ...ALLOWED, operation: "tickets.update", action: "egress" };
    const moved = (url: string): Response =>
      url.includes("/comments") ? json(COMMENT_PAGE) : ticket(FOREIGN);
    const vendor = vendorDouble(moved);
    const reply = ZENDESK_OPERATIONS.find((op) => op.effect === "egress");
    if (reply === undefined) throw new Error("no zendesk egress operation");
    const h = harness({
      provider: "zendesk",
      upstreamBase: "https://acme.zendesk.com",
      verifyToken: (): MissionClaims => ({ ...ZENDESK_CLAIMS, allow: ["read", "search", reply.name] }),
      decide: (req): CatalogDecision => (req.method === "PUT" ? write : decideZendeskish(req.path)),
      narrow: (): NarrowResult => narrowed({ path: TICKET }),
      proofs,
      fetchImpl: vendor.fetchImpl,
      operations: {
        catalogue: [reply],
        resolveScope: () => undefined,
        pipelineFor: () => undefined,
        approvals: NO_APPROVALS,
      },
    });
    // As the executor runs it: the inner call of the operation, `via` set.
    const res = await handle(h.deps, request({ method: "PUT", path: TICKET, body: "{}" }), {
      operation: reply.name,
    });

    expect(res.status).toBe(404);
    expect(vendor.urls).toEqual([`https://acme.zendesk.com${TICKET}`]);
  });
});
