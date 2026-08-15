import { randomBytes } from "node:crypto";
import { verifyMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import { bootProxy, connectionsOf, mintMission, type RunningProxy } from "./proxy";

/**
 * The proxy half B measures against, booted the way the run boots it. No
 * network and no credential: what is asserted here is the WIRING — that a
 * connector without a credential gets no connection in the mission, and that
 * the listeners bind on ephemeral ports so a suite can never collide with a
 * `missura run` the human already has open.
 */
describe("the mission this suite mints", () => {
  const key = randomBytes(32);

  it("carries only the connections whose credentials are present", () => {
    const token = mintMission(key, {
      zendesk: {
        subdomain: "acme",
        email: "a@b.c",
        apiToken: "t",
        organizationIds: ["1"],
      },
    });
    expect(verifyMissionToken(token, { key }).connections).toStrictEqual([
      "zendesk",
    ]);
  });

  it("carries no connection at all when nothing is configured", () => {
    expect(verifyMissionToken(mintMission(key, {}), { key }).connections).toStrictEqual(
      [],
    );
  });

  it("grants read and search, and nothing that writes", () => {
    expect(verifyMissionToken(mintMission(key, {}), { key }).allow).toStrictEqual([
      "read",
      "search",
    ]);
  });

  it("agrees with connectionsOf about what this run can exercise", () => {
    expect(connectionsOf({})).toStrictEqual([]);
    expect(
      connectionsOf({ github: { token: "t", repo: "o/r" } }),
    ).toStrictEqual(["github"]);
  });
});

describe("booting missura in-process", () => {
  let running: RunningProxy | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("binds every listener on an ephemeral port", async () => {
    running = await bootProxy({}, () => undefined);
    expect(running.origins.linear).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.origins.github).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.origins.linear).not.toBe(running.origins.github);
  });

  it("gives Zendesk no listener when the account's origin is unknown", async () => {
    running = await bootProxy({}, () => undefined);
    expect(running.servers.zendesk).toBeUndefined();
    expect(running.origins.zendesk).toBe("");
  });

  /**
   * The whole request path this suite depends on, with no network in it: the
   * token this run mints is accepted, the connection claim lets it through to
   * the catalog, and an uncatalogued route is refused before any vendor is
   * reached. If any of that were mis-wired, half B would report every operation
   * as refused and nobody would know it was the harness.
   */
  it("accepts this run's own mission and refuses an uncatalogued route on it", async () => {
    running = await bootProxy(
      { github: { token: "not-a-real-token", repo: "octo/repo" } },
      () => undefined,
    );
    const response = await fetch(`${running.origins.github}/user`, {
      headers: { authorization: `Bearer ${running.token}` },
    });
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("missura");
    // Refused by the catalog, so nothing was sent to GitHub with that token.
    expect(running.recorder.take()).toStrictEqual([]);
  });

  it("refuses a request carrying no mission of this run", async () => {
    running = await bootProxy({}, () => undefined);
    const response = await fetch(`${running.origins.github}/repos/o/r`);
    expect(response.status).toBe(401);
    // The refusal wears GitHub's own envelope — an SDK has to be able to read it.
    const body: unknown = await response.json();
    expect(body).toHaveProperty("message");
  });
});
