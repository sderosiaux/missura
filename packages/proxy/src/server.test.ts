import { signMissionToken } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  boot,
  GITHUB_SECRET,
  LINEAR_SECRET,
  live,
  SIGNING_KEY,
  stopAll,
  token,
} from "./server.fixtures";
import {
  DEFAULT_GITHUB_PORT,
  DEFAULT_GITHUB_UPSTREAM,
  DEFAULT_LINEAR_PORT,
  DEFAULT_LINEAR_UPSTREAM,
  MAX_BODY_BYTES,
} from "./server";

afterEach(stopAll);

describe("proxy server — defaults", () => {
  it("pins the M1 ports and upstream bases", () => {
    expect(DEFAULT_LINEAR_PORT).toBe(8481);
    expect(DEFAULT_GITHUB_PORT).toBe(8482);
    expect(DEFAULT_LINEAR_UPSTREAM).toBe("https://api.linear.app");
    expect(DEFAULT_GITHUB_UPSTREAM).toBe("https://api.github.com");
    expect(MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("proxy server — linear listener", () => {
  it("swaps the mission token for the vendor credential and passes the answer back", async () => {
    const { linearUrl } = await boot();
    const body = JSON.stringify({
      query: "query Q { issues { nodes { id } } }",
    });
    const res = await fetch(`${linearUrl}/graphql`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
      },
      body,
    });
    const text = await res.text();

    expect(res.status).toBe(203);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(text).toBe('{"data":{"viewer":{"id":"u1"}}}');

    const seen = live.upstream?.received[0];
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("/graphql");
    expect(seen?.body).toBe(body);
    expect(seen?.authorization).toBe(`Bearer ${LINEAR_SECRET}`);
    expect(seen?.authorization).not.toContain("msr_");
  });

  it("denies a mutation with 403 and never reaches the vendor", async () => {
    const { linearUrl } = await boot();
    const res = await fetch(`${linearUrl}/graphql`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: "mutation M { issueCreate(input: {}) { success } }",
      }),
    });
    const payload = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(payload.error.code).toBe("missura_denied");
    expect(live.upstream?.received).toHaveLength(0);
  });

  it("denies a non-/graphql path even with an allowlisted query body", async () => {
    const { linearUrl } = await boot();
    const res = await fetch(`${linearUrl}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "query Q { viewer { id } }" }),
    });
    const payload = (await res.json()) as {
      error: { code: string; reason: string };
    };

    expect(res.status).toBe(403);
    expect(payload.error.code).toBe("missura_denied");
    expect(payload.error.reason).toContain("/oauth/token");
    expect(live.upstream?.received).toHaveLength(0);
  });

  it("denies GET /graphql", async () => {
    const { linearUrl } = await boot();
    const res = await fetch(`${linearUrl}/graphql`, {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(403);
    expect(live.upstream?.received).toHaveLength(0);
  });
});

describe("proxy server — github listener", () => {
  it("forwards an allowlisted GET with the vendor credential and the query string", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(
      `${githubUrl}/repos/octocat/hello-world?per_page=1`,
      {
        headers: { authorization: `Bearer ${token()}` },
      },
    );

    expect(res.status).toBe(203);
    const seen = live.upstream?.received[0];
    expect(seen?.method).toBe("GET");
    expect(seen?.url).toBe("/repos/octocat/hello-world?per_page=1");
    expect(seen?.authorization).toBe(`Bearer ${GITHUB_SECRET}`);
  });

  it("answers 401 without a mission token and never reaches the vendor", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(`${githubUrl}/repos/octocat/hello-world`);
    const payload = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(payload.error.code).toBe("missura_unauthorized");
    expect(live.upstream?.received).toHaveLength(0);
  });

  it("denies a token whose mission does not carry the github connection", async () => {
    const { githubUrl } = await boot();
    const linearOnly = signMissionToken(
      {
        id: "msn_linear_only",
        purpose: "test",
        actor: "tester@local",
        scope: {},
        connections: ["linear"],
        allow: ["read", "search"],
      },
      { key: SIGNING_KEY, ttlSeconds: 60 },
    );
    const res = await fetch(`${githubUrl}/repos/octocat/hello-world`, {
      headers: { authorization: `Bearer ${linearOnly}` },
    });
    const payload = (await res.json()) as {
      error: { code: string; reason: string };
    };

    expect(res.status).toBe(403);
    expect(payload.error.reason).toBe("connection not in mission");
    expect(live.upstream?.received).toHaveLength(0);
  });

  it("denies GET /user with 403", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(`${githubUrl}/user`, {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(403);
    expect(live.upstream?.received).toHaveLength(0);
  });
});
