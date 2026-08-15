import { decideGithub, narrowGithub } from "@missura/connectors-github";
import { decideLinear, narrowLinear } from "@missura/connectors-linear";
import { decideZendesk, narrowZendesk } from "@missura/connectors-zendesk";
import type { CatalogDecision, MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import { handle, type PipelineDeps } from "./pipeline";
import { bodyText, CLAIMS, harness, request } from "./pipeline.fixtures";
import type { IncomingShape, ResponseShape } from "./transport";

/**
 * THE RESPONSE-SIDE ORACLE, tested as a property.
 *
 * A refusal decided AFTER the vendor answered used to carry the VENDOR's
 * status. That single number sorted the world for an agent scoped to
 * organization A asking about organization B: 200 when B exists — the vendor
 * answered, the filter refused — and 404 when it does not, the vendor's own
 * absence walking straight through the filter. "Exists but not yours" and
 * "never existed" were one status line apart, which is the enumeration the
 * vendor-shaped not-found exists to close, and the same class already closed on
 * the request side (`denial-leak.test.ts`) and for the parent proof
 * (`pipeline-parent-proof.test.ts`).
 *
 * So a response-side refusal answers the connector's own canonical absence: a
 * FIXED status per connector shape, never one derived from upstream.
 */

const MINE_ORG = "22989442";
const FOREIGN_ORG = "360001";
const MISSION_REPOS = [{ repo: "acme/product" }];
const MISSION_CUSTOMER = "cust_acme_01";

/** The bytes a vendor answered with, and the status it answered them at. */
interface World {
  body: string;
  status: number;
}

/**
 * Identical on every answer the doubles give, whatever the status. The
 * comparison below is about what MISSURA chooses; the relayed vendor headers
 * are the vendor's own by design — dropping the rate-limit budget only on
 * refusals would make the headers themselves the tell (`refusalHeaders` in
 * `forward.ts`).
 */
const VENDOR_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "x-rate-limit": "700",
};

/** A vendor answer no filter can prove anything about. */
const UNPROVABLE = "<html>upstream trouble</html>";

function vendor(world: World): () => Promise<Response> {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(world.body, { status: world.status, headers: VENDOR_HEADERS }),
    );
}

/** Everything the agent can observe about one answer. */
function serialized(res: ResponseShape): string {
  return JSON.stringify({
    status: res.status,
    headers: res.headers,
    body: bodyText(res.body),
  });
}

/**
 * One connector, driven end to end through its REAL catalog and NARROW: a
 * hand-written `NarrowResult` would prove the pipeline consistent with itself
 * and nothing about the connectors that ship.
 */
interface Connector {
  name: string;
  deps: Partial<PipelineDeps>;
  req: Partial<IncomingShape>;
  /** The bytes and the status this connector spells absence with. */
  absence: World;
  /**
   * The three states of the world an agent must not be able to tell apart when
   * it names an object it may not see: the object exists and is foreign, the
   * object never existed, the vendor answered something unprovable.
   */
  worlds: [World, World, World];
}

const ZENDESK_CLAIMS: MissionClaims = { ...CLAIMS, connections: ["zendesk"] };
const GITHUB_CLAIMS: MissionClaims = {
  ...CLAIMS,
  connections: ["github"],
  allow: ["read", "search"],
};
const LINEAR_CLAIMS: MissionClaims = { ...CLAIMS, connections: ["linear"] };

const ZENDESK_ABSENCE = '{"error":"RecordNotFound","description":"Not found"}';
const GITHUB_ABSENCE = '{"message":"Not Found"}';
/**
 * GraphQL has no absence status: Linear answers 200 with an `errors` array
 * whatever happened, so the refusal keeps the envelope's own shape. That these
 * bytes are not Linear's own not-found is the M3 limitation pinned in
 * `denial-leak.test.ts`; the STATUS is what this file is about.
 */
const LINEAR_ABSENCE = '{"errors":[{"message":"issue not found"}]}';

const ZENDESK: Connector = {
  name: "zendesk (REST)",
  deps: {
    provider: "zendesk",
    upstreamBase: "https://acme.zendesk.com",
    verifyToken: (): MissionClaims => ZENDESK_CLAIMS,
    decide: (req): CatalogDecision => decideZendesk(req.method, req.path),
    narrow: (req) =>
      narrowZendesk(req.path, { zendeskOrganizationIds: [MINE_ORG] }),
  },
  req: { path: "/api/v2/tickets/35436" },
  absence: { body: ZENDESK_ABSENCE, status: 404 },
  worlds: [
    // It EXISTS, and belongs to another organization: the vendor answered 200.
    {
      body: `{"ticket":{"id":35436,"organization_id":${FOREIGN_ORG}}}`,
      status: 200,
    },
    // It never existed: Zendesk's own not-found, at Zendesk's own status.
    { body: ZENDESK_ABSENCE, status: 404 },
    { body: UNPROVABLE, status: 200 },
  ],
};

const GITHUB: Connector = {
  name: "github (REST)",
  deps: {
    provider: "github",
    upstreamBase: "https://api.github.com",
    verifyToken: (): MissionClaims => GITHUB_CLAIMS,
    decide: (req): CatalogDecision => decideGithub(req.method, req.path),
    narrow: (req) => narrowGithub(req.path, { githubRepos: MISSION_REPOS }),
  },
  req: { path: "/search/issues?q=boom" },
  absence: { body: GITHUB_ABSENCE, status: 404 },
  worlds: [
    // A page whose items are not a list: nothing in it can be proven ours.
    {
      body: '{"total_count":1,"items":{"0":{"repository_url":"x"}}}',
      status: 200,
    },
    { body: GITHUB_ABSENCE, status: 404 },
    { body: UNPROVABLE, status: 200 },
  ],
};

const LINEAR: Connector = {
  name: "linear (GraphQL)",
  deps: {
    provider: "linear",
    upstreamBase: "https://api.linear.app",
    verifyToken: (): MissionClaims => LINEAR_CLAIMS,
    decide: (req): CatalogDecision =>
      decideLinear(req.method, req.path, req.body),
    narrow: (req) =>
      narrowLinear(req.body, { linearCustomerId: MISSION_CUSTOMER }),
  },
  req: {
    method: "POST",
    path: "/graphql",
    body: JSON.stringify({
      query: 'query { issue(id: "ISS-1") { id title } }',
    }),
  },
  absence: { body: LINEAR_ABSENCE, status: 200 },
  worlds: [
    {
      body: '{"data":{"issue":{"id":"ISS-1","customer":{"id":"cust_globex_99"}}}}',
      status: 200,
    },
    { body: LINEAR_ABSENCE, status: 200 },
    { body: UNPROVABLE, status: 200 },
  ],
};

const CONNECTORS: readonly Connector[] = [ZENDESK, GITHUB, LINEAR];

async function ask(connector: Connector, world: World): Promise<ResponseShape> {
  const h = harness(connector.deps, vendor(world));
  return await handle(h.deps, request(connector.req));
}

describe("response-side refusal — the vendor's status is not an oracle", () => {
  for (const connector of CONNECTORS) {
    /**
     * THE PROPERTY. Exists-but-foreign, never-existed and unprovable are the
     * same status, the same headers and the same bytes. A difference here,
     * however small, is the enumeration oracle.
     */
    it(`${connector.name}: answers foreign, absent and unprovable identically`, async () => {
      const answers: string[] = [];
      for (const world of connector.worlds) {
        answers.push(serialized(await ask(connector, world)));
      }

      expect(new Set(answers).size).toBe(1);
    });

    /**
     * The same claim from the other side: the upstream status cannot reach the
     * agent through a refusal. The vendor says the SAME unprovable thing under
     * four statuses; the agent sees one answer.
     */
    it(`${connector.name}: never lets the upstream status through a refusal`, async () => {
      const answers: string[] = [];
      for (const status of [200, 403, 404, 500]) {
        answers.push(serialized(await ask(connector, { body: UNPROVABLE, status })));
      }

      expect(new Set(answers).size).toBe(1);
    });

    it(`${connector.name}: refuses with its own canonical absence`, async () => {
      const res = await ask(connector, { body: UNPROVABLE, status: 500 });

      expect(res.status).toBe(connector.absence.status);
      expect(bodyText(res.body)).toBe(connector.absence.body);
      // The bare vendor absence and nothing of ours: a missura block on a
      // refusal taken after the vendor spoke would itself be the tell.
      expect(bodyText(res.body)).not.toContain("missura");
    });
  }
});
