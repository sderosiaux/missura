import { decideGithub, narrowGithub } from "@missura/connectors-github";
import { decideLinear, narrowLinear } from "@missura/connectors-linear";
import type { CatalogDecision, MissionClaims } from "@missura/core";
import { describe, expect, it } from "vitest";
import type { NarrowFn } from "./narrow";
import { handle } from "./pipeline";
import { bodyText, CLAIMS, harness, request } from "./pipeline.fixtures";

/**
 * The non-leak rule, tested as a property rather than as a sentence
 * (SPEC §4.8bis): a refusal is derived from the mission the agent ALREADY
 * holds, never from the target it was refused. Naming the target would confirm
 * an out-of-scope object exists, and that turns every error into an
 * enumeration oracle — which is precisely what the vendor-shaped not-found
 * exists to close.
 *
 * So each case below is driven through the REAL connectors with a foreign
 * identifier, and the whole serialized answer — status, headers and body — is
 * searched for it.
 */

const MISSION_CUSTOMER = "cust_acme_01";
const MISSION_REPOS = ["acme/product", "acme/infra"];

/** None of these shares a substring with anything the mission covers. */
const FOREIGN = [
  "globexcorp",
  "hidden-project",
  "ISS-GLOBEX-12",
  "cust_globex_99",
  "0f9d1b77-globex",
];

const SCOPED: MissionClaims = {
  ...CLAIMS,
  scope: { customer: "acme" },
  connections: ["linear", "github"],
  allow: ["read", "search"],
  exp: Math.floor(Date.now() / 1000) + 600,
};

const githubNarrow: NarrowFn = (req) =>
  narrowGithub(req.path, {
    githubRepos: MISSION_REPOS.map((repo) => ({ repo })),
  });

const linearNarrow: NarrowFn = (req) =>
  narrowLinear(req.body, { linearCustomerId: MISSION_CUSTOMER });

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

function expectNoForeign(payload: string): void {
  const haystack = payload.toLowerCase();
  for (const needle of FOREIGN) {
    expect(haystack, `leaked ${needle}`).not.toContain(needle.toLowerCase());
  }
}

describe("non-leak rule — a denial never names the target it refused", () => {
  it("refuses a foreign repo without repeating its owner or its name", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => SCOPED,
      decide: (req): CatalogDecision => decideGithub(req.method, req.path),
      narrow: githubNarrow,
    });
    const res = await handle(
      h.deps,
      request({ path: "/repos/globexcorp/hidden-project" }),
    );

    expect(res.status).toBe(404);
    expect(h.fetchCount()).toBe(0);
    expectNoForeign(serialized(res));
  });

  it("refuses an issue inside a foreign repo the same way", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => SCOPED,
      decide: (req): CatalogDecision => decideGithub(req.method, req.path),
      narrow: githubNarrow,
    });
    const res = await handle(
      h.deps,
      request({ path: "/repos/globexcorp/hidden-project/issues/4242" }),
    );

    expect(res.status).toBe(404);
    expectNoForeign(serialized(res));
  });

  it("refuses a foreign owner id without echoing it back", async () => {
    const h = harness({
      provider: "linear",
      upstreamBase: "https://api.linear.app",
      verifyToken: (): MissionClaims => SCOPED,
      decide: (req): CatalogDecision =>
        decideLinear(req.method, req.path, req.body),
      narrow: linearNarrow,
    });
    const res = await handle(
      h.deps,
      request({
        method: "POST",
        path: "/graphql",
        body: JSON.stringify({
          query: 'query { customer(id: "cust_globex_99") { id name } }',
        }),
      }),
    );

    expect(res.status).toBe(403);
    expect(h.fetchCount()).toBe(0);
    expectNoForeign(serialized(res));
  });

  /**
   * The one denial produced AFTER the vendor answered: the object came back and
   * the filter proved it foreign. What IS proven here is the non-leak rule —
   * both the id the agent guessed and the owner id the vendor disclosed
   * disappear, and the answer is a constant that describes nothing.
   *
   * What is NOT proven, and used to be claimed here: that this reads like an
   * issue which never existed. It does not. See the known limitation below and
   * SPEC §7 (M3).
   */
  it("refuses a foreign issue on the way back without naming anything", async () => {
    const h = harness(
      {
        provider: "linear",
        upstreamBase: "https://api.linear.app",
        verifyToken: (): MissionClaims => SCOPED,
        decide: (req): CatalogDecision =>
          decideLinear(req.method, req.path, req.body),
        narrow: linearNarrow,
      },
      (): Promise<Response> =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "ISS-GLOBEX-12",
                  customer: { id: "0f9d1b77-globex" },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );
    const res = await handle(
      h.deps,
      request({
        method: "POST",
        path: "/graphql",
        body: JSON.stringify({
          query: 'query { issue(id: "ISS-GLOBEX-12") { id title } }',
        }),
      }),
    );

    expect(h.fetchCount()).toBe(1);
    expect(h.events[0]?.decision).toBe("deny");
    expectNoForeign(serialized(res));
    expect(bodyText(res.body)).toBe(
      '{"errors":[{"message":"issue not found"}]}',
    );
  });

  /**
   * KNOWN LIMITATION, pinned so a fix shows up as a change here (SPEC §7, M3).
   *
   * `query { issue(id:"…") }` has three distinguishable answers, and the id an
   * agent guesses selects between them:
   *   - an id that never existed → Linear's own error, with a `path`, an
   *     `extensions` block and `"data":{"issue":null}` beside it;
   *   - a datum the vendor nulled → `{"data":{"issue":null}}`, no `errors`;
   *   - an id that EXISTS but belongs to another customer → the constant below.
   * So guessing ids separates exists-but-not-yours from does-not-exist. It is
   * pre-existing from M2 and is not fixed by synthesizing Linear's shape,
   * because that shape could not be established with evidence — see
   * `NOT_FOUND_GRAPHQL_BODY`.
   */
  it("answers a foreign object differently from a vendor-nulled one — known limitation", async () => {
    const vendor =
      (body: unknown): (() => Promise<Response>) =>
      (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
    const ask = async (body: unknown): Promise<string> => {
      const h = harness(
        {
          provider: "linear",
          upstreamBase: "https://api.linear.app",
          verifyToken: (): MissionClaims => SCOPED,
          decide: (req): CatalogDecision =>
            decideLinear(req.method, req.path, req.body),
          narrow: linearNarrow,
        },
        vendor(body),
      );
      const res = await handle(
        h.deps,
        request({
          method: "POST",
          path: "/graphql",
          body: JSON.stringify({
            query: 'query { issue(id: "ISS-1") { id title } }',
          }),
        }),
      );
      return bodyText(res.body);
    };

    const foreign = await ask({
      data: { issue: { id: "ISS-1", customer: { id: "0f9d1b77-globex" } } },
    });
    const nulled = await ask({ data: { issue: null } });

    expect(foreign).not.toBe(nulled);
  });

  /**
   * "Does not exist" and "exists but out of scope" are decided identically —
   * before the vendor is asked at all — so the two answers are the same bytes,
   * the same status and the same headers. A difference here, however small,
   * would be the oracle.
   */
  it("answers a foreign repo and a repo that never existed identically", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => SCOPED,
      decide: (req): CatalogDecision => decideGithub(req.method, req.path),
      narrow: githubNarrow,
    });
    const real = await handle(
      h.deps,
      request({ path: "/repos/globexcorp/hidden-project" }),
    );
    const imaginary = await handle(
      h.deps,
      request({ path: "/repos/nobody-at-all/no-such-thing" }),
    );

    expect(serialized(real)).toBe(serialized(imaginary));
  });

  /**
   * The one place a denial does repeat something: the catalog names the route
   * the agent itself asked for, because that reason is also the audit
   * breadcrumb. It confirms nothing — the agent wrote that path — but the
   * REMEDIATION must still be built from the mission alone, so the block is
   * checked separately from the echo.
   */
  it("never lets a target reach the remediation, even when the reason echoes the request", async () => {
    const h = harness({
      verifyToken: (): MissionClaims => SCOPED,
      decide: (req): CatalogDecision => decideGithub(req.method, req.path),
      narrow: githubNarrow,
    });
    const res = await handle(
      h.deps,
      request({ path: "/globexcorp/hidden-project/secrets" }),
    );

    expect(res.status).toBe(403);
    const parsed = JSON.parse(bodyText(res.body)) as {
      missura: Record<string, unknown>;
    };
    const { reason, ...rest } = parsed.missura;
    expect(String(reason)).toContain("globexcorp");
    expectNoForeign(JSON.stringify(rest));
  });
});
