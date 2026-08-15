import { decideZendesk, narrowZendesk } from "@missura/connectors-zendesk";
import {
  createParentProofStore,
  type CatalogDecision,
  type MissionClaims,
  type ParentProofStore,
} from "@missura/core";
import { describe, expect, it } from "vitest";
import type { NarrowFn } from "./narrow";
import { handle } from "./pipeline";
import { bodyText, CLAIMS, harness, request } from "./pipeline.fixtures";

/**
 * The Zendesk comment listing, end to end, through the REAL connector: its
 * catalog decides, its NARROW emits the parent proof, and this pipeline honours
 * it. The connector's own suites prove each half; this one proves they FIT —
 * nothing else type-checks the connector's result against `NarrowResult`, since
 * the two are structurally compatible by design rather than by import.
 */

const MINE = "22989442";
const FOREIGN = "77000111";
const SCOPE = { zendeskOrganizationIds: [MINE] };

const COMMENTS = "/api/v2/tickets/35436/comments";
const TICKET = "/api/v2/tickets/35436";

const ZENDESK_CLAIMS: MissionClaims = {
  ...CLAIMS,
  connections: ["zendesk"],
  jti: "jti-zendesk",
};

const narrow: NarrowFn = (req) => narrowZendesk(req.path, SCOPE);

const COMMENT_PAGE = {
  comments: [
    {
      id: 1,
      body: "we shipped it",
      author_id: 7,
      attachments: [{ id: 3, content_url: "https://files.example/secret.pdf" }],
    },
  ],
  count: 1,
  next_page: `https://acme.zendesk.com${COMMENTS}?page=2`,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Setup {
  deps: Parameters<typeof handle>[0];
  urls: string[];
  events: { decision: string; operation: string }[];
}

function setup(
  route: (url: string) => Response,
  proofs: ParentProofStore = createParentProofStore(),
): Setup {
  const urls: string[] = [];
  const h = harness({
    provider: "zendesk",
    upstreamBase: "https://acme.zendesk.com",
    verifyToken: (): MissionClaims => ZENDESK_CLAIMS,
    decide: (req): CatalogDecision => decideZendesk(req.method, req.path),
    narrow,
    proofs,
    now: (): number => 1_700_000_000_000,
    fetchImpl: (input): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      urls.push(url);
      return Promise.resolve(route(url));
    },
  });
  return { deps: h.deps, urls, events: h.events };
}

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

const ticketOwnedBy =
  (organizationId: string) =>
  (url: string): Response =>
    url.includes("/comments")
      ? json(COMMENT_PAGE)
      : json({ ticket: { id: 35436, organization_id: Number(organizationId) } });

describe("zendesk comments — served behind a proof of their ticket", () => {
  it("proves the ticket, then hands over the comments", async () => {
    const { deps, urls } = setup(ticketOwnedBy(MINE));
    const res = await handle(deps, request({ path: COMMENTS }));

    expect(res.status).toBe(200);
    expect(urls).toEqual([
      `https://acme.zendesk.com${TICKET}`,
      `https://acme.zendesk.com${COMMENTS}`,
    ]);
  });

  /**
   * The attachment refusal, honoured through the body. `/api/v2/attachments/*`
   * is denied by name because a `content_url` points at a host outside this
   * connection; a comment carries those URLs inline, so the plan takes them
   * back. `next_page` goes for the reason every vendor position does.
   */
  it("takes back the attachment URLs and the vendor's own position", async () => {
    const { deps } = setup(ticketOwnedBy(MINE));
    const res = await handle(deps, request({ path: COMMENTS }));
    const body = bodyText(res.body);

    expect(body).not.toContain("files.example");
    expect(body).not.toContain("attachments");
    expect(body).not.toContain("next_page");
    expect(body).toContain("we shipped it");
  });

  it("does not re-prove the ticket while paging through its comments", async () => {
    const proofs = createParentProofStore();
    const first = setup(ticketOwnedBy(MINE), proofs);
    await handle(first.deps, request({ path: COMMENTS }));
    const second = setup(ticketOwnedBy(MINE), proofs);
    await handle(second.deps, request({ path: `${COMMENTS}?page=2` }));

    expect(second.urls).toEqual([
      `https://acme.zendesk.com${COMMENTS}?page=2`,
    ]);
  });

  it("shows the probe as its own decision in the audit", async () => {
    const { deps, events } = setup(ticketOwnedBy(MINE));
    await handle(deps, request({ path: COMMENTS }));

    expect(events.map((e) => e.operation)).toEqual([
      "tickets.get",
      "tickets.comments.list",
    ]);
  });

  /**
   * THE PROPERTY, through the real connector. An agent walking ticket ids must
   * not be able to sort them into "exists but is not mine", "does not exist"
   * and "the probe broke" — the three are the same bytes.
   */
  it("refuses a foreign ticket, an absent one and a broken probe identically", async () => {
    const routes: ((url: string) => Response)[] = [
      ticketOwnedBy(FOREIGN),
      (url): Response =>
        url.includes("/comments")
          ? json(COMMENT_PAGE)
          : json({ error: "RecordNotFound", description: "Not found" }, 404),
      (url): Response => {
        if (!url.includes("/comments")) throw new Error("vendor down");
        return json(COMMENT_PAGE);
      },
    ];
    const answers: string[] = [];
    for (const route of routes) {
      const { deps } = setup(route);
      answers.push(serialized(await handle(deps, request({ path: COMMENTS }))));
    }

    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0] ?? "{}")).toMatchObject({ status: 404 });
  });

  /**
   * And the refusal reads like the one a ticket outside the mission already
   * got: same vendor absence, a remediation built from the mission's own count.
   */
  it("wears Zendesk's own absence and never names the ticket", async () => {
    const { deps } = setup(ticketOwnedBy(FOREIGN));
    const res = await handle(deps, request({ path: COMMENTS }));
    const body = bodyText(res.body);

    expect(JSON.parse(body)).toMatchObject({
      error: "RecordNotFound",
      description: "Not found",
    });
    expect(body).not.toContain("35436");
    expect(body).not.toContain(FOREIGN);
    expect(body).toContain("1 organization");
  });

  /** The refusals the catalog names are untouched by any of this. */
  it.each([
    "/api/v2/tickets/1/comments/2/attachments/3/redact",
    "/api/v2/incremental/tickets",
    "/api/v2/job_statuses/abc",
    "/api/v2/search/export?query=type:ticket",
    "/api/v2/tickets/show_many?ids=1,2",
    "/api/v2/audit_logs",
  ])("still refuses %s before anything is asked of the vendor", async (path) => {
    const { deps, urls } = setup(ticketOwnedBy(MINE));
    const res = await handle(deps, request({ path }));

    expect(res.status).toBe(403);
    expect(urls).toEqual([]);
  });
});
