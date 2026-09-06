import { afterEach, describe, expect, it } from "vitest";
import { OPERATION_ROUTE } from "./operations";
import {
  boot,
  events,
  GITHUB_SECRET,
  LINEAR_SECRET,
  live,
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
