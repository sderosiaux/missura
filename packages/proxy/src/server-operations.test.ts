import { signMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATION_ROUTE } from "./operations";
import {
  boot,
  events,
  GITHUB_SECRET,
  LINEAR_SECRET,
  live,
  SIGNING_KEY,
  stopAll,
  token,
} from "./server.fixtures";

/**
 * The operation route over real HTTP, on the listeners `createServers` wires:
 * an operation POSTed to the LINEAR port runs its inner call on the GITHUB
 * pipeline — GitHub's route, GitHub's credential — and never Linear's.
 */

afterEach(stopAll);

describe("proxy server — POST /missura/op/<name>", () => {
  it("runs a GitHub operation on the GitHub pipeline whatever listener took it", async () => {
    const { linearUrl } = await boot();
    const res = await fetch(`${linearUrl}${OPERATION_ROUTE}github.issues.for_entity`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      operation: "github.issues.for_entity",
      effect: "read",
      results: [{ data: { viewer: { id: "u1" } } }],
    });
    expect(live.upstream?.received).toEqual([
      {
        method: "GET",
        url: "/repos/octocat/hello-world/issues?state=open",
        authorization: `Bearer ${GITHUB_SECRET}`,
        body: "",
      },
    ]);
    expect(live.upstream?.received[0]?.authorization).not.toContain(LINEAR_SECRET);
    // Two records: the inner call on github, the operation on linear.
    expect(events.map((ev) => [ev.provider, ev.operation, ev.viaOperation])).toEqual([
      ["github", "repos.issues.list", "github.issues.for_entity"],
      ["linear", "missura.op", "github.issues.for_entity"],
    ]);
  });

  it("refuses a name the proxy does not serve, and reaches no vendor", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(`${githubUrl}${OPERATION_ROUTE}zendesk.tickets.for_entity`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}` },
    });
    const payload = (await res.json()) as { missura: { code: string } };

    expect(res.status).toBe(404);
    expect(payload.missura.code).toBe("missura_operation_unknown");
    expect(live.upstream?.received).toEqual([]);
  });
});

/**
 * THE UNFORGEABILITY PROOF, on the wire. The write route is gated on the
 * in-process operation context the executor sets on the inner requests it
 * builds. The listener builds a request from method, URL, headers and body —
 * so nothing an agent sends over HTTP can carry that context, and every
 * spelling of "I am an inner call" below is just a header the vendor never
 * sees. The same token, on the operation route, writes.
 */
describe("proxy server — the write route cannot be reached from the wire", () => {
  const OP = "github.issue.comment.create";
  const COMMENTS = "/repos/octocat/hello-world/issues/7/comments";

  function granted(): string {
    return signMissionToken(
      {
        id: "msn_write",
        purpose: "m8 over http",
        actor: "tester@local",
        scope: { repos: ["octocat/hello-world"] },
        connections: ["github"],
        allow: ["read", "search", OP],
        degraded: [],
      },
      { key: SIGNING_KEY, ttlSeconds: 60 },
    );
  }

  it("refuses a raw POST whatever headers claim about it, and reaches no vendor", async () => {
    const { githubUrl } = await boot();
    const spoofs: Record<string, string>[] = [
      {},
      { "x-missura-via": OP },
      { "missura-via": OP, "missura-operation": OP },
      { via: JSON.stringify({ operation: OP }) },
      { "x-missura-inner": "1" },
    ];
    for (const spoof of spoofs) {
      const res = await fetch(`${githubUrl}${COMMENTS}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${granted()}`,
          "content-type": "application/json",
          ...spoof,
        },
        body: '{"body":"from the wire"}',
      });
      const payload = (await res.json()) as { missura: { code: string } };
      expect(res.status).toBe(403);
      expect(payload.missura.code).toBe("missura_operation_not_in_catalog");
    }
    expect(live.upstream?.received).toEqual([]);
  });

  it("writes through the operation route with that same token", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(`${githubUrl}${OPERATION_ROUTE}${OP}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${granted()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ repo: "octocat/hello-world", issue: 7, body: "from the op" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ operation: OP, effect: "append" });
    expect(live.upstream?.received).toEqual([
      {
        method: "POST",
        url: COMMENTS,
        authorization: `Bearer ${GITHUB_SECRET}`,
        body: '{"body":"from the op"}',
      },
    ]);
    expect(events.map((ev) => [ev.operation, ev.action, ev.decision])).toEqual([
      ["repos.issues.comments.create", "append", "allow"],
      ["missura.op", "append", "allow"],
    ]);
  });
});
