import {
  createParentProofStore,
  type CatalogDecision,
  type MissionClaims,
  type ParentProofStore,
} from "@missura/core";
import { describe, expect, it } from "vitest";
import type { NarrowResult } from "./narrow";
import { handle } from "./pipeline";
import {
  bodyText,
  CLAIMS,
  harness,
  request,
  VENDOR_HEADER,
} from "./pipeline.fixtures";

/**
 * PARENT PROOF, at the pipeline: a child the connector cannot prove from its own
 * response is served only after its PARENT is proven to belong to the mission.
 *
 * Zendesk's ticket comments are the case that forced it — a comment publishes
 * neither an organization nor a ticket — but nothing here is Zendesk-shaped:
 * the pipeline sees a key, a probe and an owner path.
 */

const TICKET = "/api/v2/tickets/35436";
const COMMENTS = "/api/v2/tickets/35436/comments";
const MINE = "22989442";
const FOREIGN = "360001";

const ZENDESK_CLAIMS: MissionClaims = {
  ...CLAIMS,
  connections: ["zendesk"],
  jti: "jti-proof",
};

const ALLOWED: CatalogDecision = {
  decision: "allow",
  operation: "tickets.comments.list",
  action: "read",
  reason: "allowlisted route",
};

const PROBE_ALLOWED: CatalogDecision = {
  decision: "allow",
  operation: "tickets.get",
  action: "read",
  reason: "allowlisted route",
};

function decideZendeskish(path: string): CatalogDecision {
  if (path.startsWith(COMMENTS)) return ALLOWED;
  if (path.startsWith(TICKET)) return PROBE_ALLOWED;
  return {
    decision: "deny",
    operation: "unknown",
    action: "unknown",
    reason: "not in the Zendesk read catalog",
  };
}

function narrowed(over: Partial<NarrowResult> = {}): NarrowResult {
  return {
    decision: "allow",
    path: COMMENTS,
    denyShape: "zendesk404",
    missionScopeSize: 2,
    missionOwnerIds: [MINE],
    parentProof: {
      key: "ticket:35436",
      probe: { method: "GET", path: TICKET, body: "" },
      ownerPath: ["ticket", "organization_id"],
    },
    filterPlan: { rules: [], strip: [] },
    ...over,
  };
}

interface Vendor {
  fetchImpl: typeof fetch;
  urls: string[];
  auth: (string | undefined)[];
}

function vendorDouble(route: (url: string) => Response): Vendor {
  const urls: string[] = [];
  const auth: (string | undefined)[] = [];
  return {
    urls,
    auth,
    fetchImpl: (input, init): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      urls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      auth.push(headers.authorization);
      return Promise.resolve(route(url));
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const COMMENT_PAGE = { comments: [{ id: 1, body: "hello" }], count: 1 };

/** The parent as the vendor answers it, owned by `organizationId`. */
function ticket(organizationId: string): Response {
  return json({ ticket: { id: 35436, organization_id: Number(organizationId) } });
}

interface Setup {
  deps: Parameters<typeof handle>[0];
  vendor: Vendor;
  events: { decision: string; operation: string }[];
}

function setup(
  route: (url: string) => Response,
  over: {
    result?: NarrowResult;
    proofs?: ParentProofStore;
    isRevoked?: (jti: string) => boolean;
  } = {},
): Setup {
  const vendor = vendorDouble(route);
  const result = over.result ?? narrowed();
  const h = harness({
    provider: "zendesk",
    upstreamBase: "https://acme.zendesk.com",
    verifyToken: (): MissionClaims => ZENDESK_CLAIMS,
    decide: (req): CatalogDecision => decideZendeskish(req.path),
    narrow: (): NarrowResult => result,
    proofs: over.proofs ?? createParentProofStore(),
    fetchImpl: vendor.fetchImpl,
    now: (): number => 1_700_000_000_000,
    ...(over.isRevoked === undefined ? {} : { isRevoked: over.isRevoked }),
  });
  return { deps: h.deps, vendor, events: h.events };
}

/** Everything the agent can observe about one answer. */
function serialized(res: {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}): string {
  return JSON.stringify({
    status: res.status,
    headers: res.headers,
    body: bodyText(res.body),
  });
}

const owned = (url: string): Response =>
  url.includes("/comments") ? json(COMMENT_PAGE) : ticket(MINE);

describe("parent proof — proving the parent before serving the child", () => {
  it("asks the vendor for the parent first, then for the child", async () => {
    const { deps, vendor } = setup(owned);
    const res = await handle(deps, request({ path: COMMENTS }));

    expect(res.status).toBe(200);
    expect(vendor.urls).toEqual([
      `https://acme.zendesk.com${TICKET}`,
      `https://acme.zendesk.com${COMMENTS}`,
    ]);
    expect(JSON.parse(bodyText(res.body))).toEqual(COMMENT_PAGE);
  });

  /**
   * The probe goes out through the SAME forward as everything else, which is
   * what keeps credential injection in one place: it carries OUR vendor header
   * and never the agent's mission token.
   */
  it("issues the probe with the vendor credential, never the agent's token", async () => {
    const { deps, vendor } = setup(owned);
    await handle(deps, request({ path: COMMENTS }));

    expect(vendor.auth).toEqual([VENDOR_HEADER, VENDOR_HEADER]);
    expect(vendor.auth.join()).not.toContain("msr_mission_token");
  });

  it("does not pay for a probe twice in one mission", async () => {
    const proofs = createParentProofStore();
    const first = setup(owned, { proofs });
    await handle(first.deps, request({ path: COMMENTS }));
    const second = setup(owned, { proofs });
    const res = await handle(second.deps, request({ path: COMMENTS }));

    expect(res.status).toBe(200);
    expect(second.vendor.urls).toEqual([`https://acme.zendesk.com${COMMENTS}`]);
  });

  /**
   * A proof is one mission's. Another token — same agent, same ticket — buys
   * its own probe, because its scope was resolved separately.
   */
  it("never lends a proof to another mission", async () => {
    const proofs = createParentProofStore();
    const first = setup(owned, { proofs });
    await handle(first.deps, request({ path: COMMENTS }));

    const vendor = vendorDouble(owned);
    const result = narrowed();
    const other = harness({
      provider: "zendesk",
      upstreamBase: "https://acme.zendesk.com",
      verifyToken: (): MissionClaims => ({ ...ZENDESK_CLAIMS, jti: "jti-two" }),
      decide: (req): CatalogDecision => decideZendeskish(req.path),
      narrow: (): NarrowResult => result,
      proofs,
      fetchImpl: vendor.fetchImpl,
    });
    await handle(other.deps, request({ path: COMMENTS }));

    expect(vendor.urls).toHaveLength(2);
  });

  /**
   * Like REFILL: an extra vendor call is an extra DECISION, so the audit shows
   * the load a mission really caused and its request budget is not silently
   * multiplied by a stage nobody can see.
   */
  it("records the probe as its own decision event", async () => {
    const { deps, events } = setup(owned);
    await handle(deps, request({ path: COMMENTS }));

    expect(events.map((e) => e.operation)).toEqual([
      "tickets.get",
      "tickets.comments.list",
    ]);
    expect(events.every((e) => e.decision === "allow")).toBe(true);
  });
});

describe("parent proof — the refusals, and their indistinguishability", () => {
  const foreign = (url: string): Response =>
    url.includes("/comments") ? json(COMMENT_PAGE) : ticket(FOREIGN);
  const ownerless = (url: string): Response =>
    url.includes("/comments") ? json(COMMENT_PAGE) : json({ ticket: { id: 1 } });
  const absent = (url: string): Response =>
    url.includes("/comments")
      ? json(COMMENT_PAGE)
      : json({ error: "RecordNotFound", description: "Not found" }, 404);

  /**
   * THE PROPERTY. An agent must not be able to sort ticket ids into "exists but
   * is not mine", "does not exist" and "the probe broke": the three are the
   * same bytes, the same status and the same headers, because the refusal is
   * built from the mission alone and decided before the child is ever asked
   * for.
   *
   * Timing is the known residual — a first access costs a round trip and a
   * cached proof does not. It is stated rather than papered over: closing it
   * would mean a fixed delay on every response, which the proxy does not do.
   */
  it("answers foreign, ownerless, absent and unreachable parents identically", async () => {
    const answers: string[] = [];
    for (const route of [foreign, ownerless, absent]) {
      const { deps } = setup(route);
      answers.push(serialized(await handle(deps, request({ path: COMMENTS }))));
    }
    const broken = setup(() => {
      throw new Error("vendor down");
    });
    answers.push(
      serialized(await handle(broken.deps, request({ path: COMMENTS }))),
    );

    expect(new Set(answers).size).toBe(1);
  });

  it("never asks for the child once the parent failed", async () => {
    const { deps, vendor } = setup(foreign);
    const res = await handle(deps, request({ path: COMMENTS }));

    expect(res.status).toBe(404);
    expect(vendor.urls).toEqual([`https://acme.zendesk.com${TICKET}`]);
  });

  it("wears the vendor's own absence, with the mission's remediation", async () => {
    const { deps } = setup(foreign);
    const res = await handle(deps, request({ path: COMMENTS }));
    const body = JSON.parse(bodyText(res.body)) as {
      error: string;
      description: string;
      missura: { remediation: string };
    };

    expect(body.error).toBe("RecordNotFound");
    expect(body.description).toBe("Not found");
    expect(body.missura.remediation).toContain("2 organizations");
    expect(bodyText(res.body)).not.toContain("35436");
  });

  it("refuses a probe the catalog does not admit, without calling anything", async () => {
    const { deps, vendor } = setup(owned, {
      result: narrowed({
        parentProof: {
          key: "ticket:35436",
          probe: { method: "GET", path: "/api/v2/incremental/tickets", body: "" },
          ownerPath: ["ticket", "organization_id"],
        },
      }),
    });
    const res = await handle(deps, request({ path: COMMENTS }));

    expect(res.status).toBe(404);
    expect(vendor.urls).toEqual([]);
  });

  it("refuses a probe that would leave the connector's origin", async () => {
    const { deps, vendor } = setup(owned, {
      result: narrowed({
        parentProof: {
          key: "ticket:35436",
          probe: { method: "GET", path: "https://evil.example/tickets", body: "" },
          ownerPath: ["ticket", "organization_id"],
        },
      }),
    });
    const res = await handle(deps, request({ path: COMMENTS }));

    expect(res.status).toBe(404);
    expect(vendor.urls).toEqual([]);
  });

  /**
   * A connector that names no owner set covers nothing: the empty set owns
   * nothing, exactly as an empty `expectedOwnerIds` does in a `FilterRule`. A
   * missing policy input must never read as PASS.
   */
  it("proves nothing when the mission resolves to no owner", async () => {
    const { deps, vendor } = setup(owned, {
      result: narrowed({ missionOwnerIds: [] }),
    });
    const res = await handle(deps, request({ path: COMMENTS }));

    expect(res.status).toBe(404);
    expect(vendor.urls).toHaveLength(1);
  });

  /**
   * Revocation is read on the hot path before any stage that could consult the
   * store, so a proof a mission already bought cannot outlive its recall — not
   * by a request.
   */
  it("does not honour a proof once the mission is revoked", async () => {
    const proofs = createParentProofStore();
    const first = setup(owned, { proofs });
    await handle(first.deps, request({ path: COMMENTS }));

    const after = setup(owned, { proofs, isRevoked: (): boolean => true });
    const res = await handle(after.deps, request({ path: COMMENTS }));

    expect(res.status).toBe(401);
    expect(after.vendor.urls).toEqual([]);
  });
});
