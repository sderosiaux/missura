import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { signDevToken, type DecisionEvent } from "@missura/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createServers,
  DEFAULT_GITHUB_PORT,
  DEFAULT_GITHUB_UPSTREAM,
  DEFAULT_LINEAR_PORT,
  DEFAULT_LINEAR_UPSTREAM,
  MAX_BODY_BYTES,
  type ProxyServers,
} from "./server";

const SIGNING_KEY = randomBytes(32);
const LINEAR_SECRET = "lin_api_secret_value";
const GITHUB_SECRET = "ghp_secret_value";

/** Internal test double: a local vendor that records what the proxy sent it. */
interface Upstream {
  server: Server;
  base: string;
  received: {
    method: string;
    url: string;
    authorization?: string;
    body: string;
  }[];
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const received: Upstream["received"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const auth = req.headers.authorization;
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        ...(auth === undefined ? {} : { authorization: auth }),
        body,
      });
      res.writeHead(203, { "content-type": "application/json; charset=utf-8" });
      res.end('{"data":{"viewer":{"id":"u1"}}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    base: `http://127.0.0.1:${String(port)}`,
    received,
    close: (): Promise<void> =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

let running: ProxyServers | undefined;
let upstream: Upstream | undefined;

afterEach(async () => {
  await running?.close();
  await upstream?.close();
  running = undefined;
  upstream = undefined;
});

const events: DecisionEvent[] = [];

async function boot(): Promise<{ linearUrl: string; githubUrl: string }> {
  upstream = await startUpstream();
  events.length = 0;
  running = await createServers({
    signingKey: SIGNING_KEY,
    emit: (ev: DecisionEvent): void => {
      events.push(ev);
    },
    linear: {
      vendorAuthHeader: `Bearer ${LINEAR_SECRET}`,
      port: 0,
      upstreamBase: upstream.base,
    },
    github: {
      vendorAuthHeader: `Bearer ${GITHUB_SECRET}`,
      port: 0,
      upstreamBase: upstream.base,
    },
  });
  const linear = running.linear.address() as AddressInfo;
  const github = running.github.address() as AddressInfo;
  return {
    linearUrl: `http://127.0.0.1:${String(linear.port)}`,
    githubUrl: `http://127.0.0.1:${String(github.port)}`,
  };
}

function token(): string {
  return signDevToken({ key: SIGNING_KEY, ttlSeconds: 60 });
}

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

    const seen = upstream?.received[0];
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
    expect(upstream?.received).toHaveLength(0);
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
    const seen = upstream?.received[0];
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
    expect(upstream?.received).toHaveLength(0);
  });

  it("denies GET /user with 403", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(`${githubUrl}/user`, {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(403);
    expect(upstream?.received).toHaveLength(0);
  });
});

describe("proxy server — limits and lifecycle", () => {
  it("answers 413 above the 10 MB body cap and never reaches the vendor", async () => {
    const { githubUrl } = await boot();
    const res = await fetch(`${githubUrl}/repos/octocat/hello-world`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
      },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    const payload = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(413);
    expect(payload.error.code).toBe("missura_request_too_large");
    expect(upstream?.received).toHaveLength(0);
  }, 30_000);

  it("logs one decision event per request", async () => {
    const { githubUrl } = await boot();
    await fetch(`${githubUrl}/repos/octocat/hello-world`, {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.provider).toBe("github");
    expect(events[0]?.decision).toBe("allow");
    expect(JSON.stringify(events)).not.toContain(GITHUB_SECRET);
  });

  it("closes both listeners gracefully", async () => {
    const { githubUrl, linearUrl } = await boot();
    await running?.close();
    running = undefined;

    await expect(fetch(githubUrl)).rejects.toThrow();
    await expect(fetch(linearUrl)).rejects.toThrow();
  });
});
