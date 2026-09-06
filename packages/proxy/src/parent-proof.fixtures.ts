import {
  createParentProofStore,
  type CatalogDecision,
  type MissionClaims,
  type ParentProofStore,
} from "@missura/core";
import type { NarrowResult } from "./narrow";
import type { handle } from "./pipeline";
import { bodyText, CLAIMS, harness } from "./pipeline.fixtures";

/**
 * Shared rig for the parent-proof specs (not exported by the package index):
 * a Zendesk-shaped connector whose comments route needs the ticket proven,
 * and a vendor double that answers the ticket owned by whoever the test says.
 */

export const TICKET = "/api/v2/tickets/35436";
export const COMMENTS = "/api/v2/tickets/35436/comments";
export const MINE = "22989442";
export const FOREIGN = "360001";

export const ZENDESK_CLAIMS: MissionClaims = {
  ...CLAIMS,
  connections: ["zendesk"],
  jti: "jti-proof",
};

export const ALLOWED: CatalogDecision = {
  decision: "allow",
  operation: "tickets.comments.list",
  action: "read",
  reason: "allowlisted route",
};

export const PROBE_ALLOWED: CatalogDecision = {
  decision: "allow",
  operation: "tickets.get",
  action: "read",
  reason: "allowlisted route",
};

export function decideZendeskish(path: string): CatalogDecision {
  if (path.startsWith(COMMENTS)) return ALLOWED;
  if (path.startsWith(TICKET)) return PROBE_ALLOWED;
  return {
    decision: "deny",
    operation: "unknown",
    action: "unknown",
    reason: "not in the Zendesk read catalog",
  };
}

export function narrowed(over: Partial<NarrowResult> = {}): NarrowResult {
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

export interface Vendor {
  fetchImpl: typeof fetch;
  urls: string[];
  auth: (string | undefined)[];
}

export function vendorDouble(route: (url: string) => Response): Vendor {
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

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const COMMENT_PAGE = { comments: [{ id: 1, body: "hello" }], count: 1 };

/** The parent as the vendor answers it, owned by `organizationId`. */
export function ticket(organizationId: string): Response {
  return json({ ticket: { id: 35436, organization_id: Number(organizationId) } });
}

export interface Setup {
  deps: Parameters<typeof handle>[0];
  vendor: Vendor;
  events: { decision: string; operation: string }[];
}

export function setup(
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
export function serialized(res: {
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

export const owned = (url: string): Response =>
  url.includes("/comments") ? json(COMMENT_PAGE) : ticket(MINE);
