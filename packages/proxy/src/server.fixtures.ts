import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { signDevToken, type DecisionEvent } from "@missura/core";
import { passThroughNarrow } from "./narrow";
import { createServers, type ProxyServers } from "./server";

/**
 * Shared harness for the server specs (not exported by the package index): a
 * local vendor double, a proxy booted on ephemeral ports against it, and the
 * event sink both write into. The double is internal to the tests — the proxy
 * never ships one.
 */
export const SIGNING_KEY = randomBytes(32);
export const LINEAR_SECRET = "lin_api_secret_value";
export const GITHUB_SECRET = "ghp_secret_value";

/** Internal test double: a local vendor that records what the proxy sent it. */
export interface Upstream {
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

export async function startUpstream(): Promise<Upstream> {
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

/** What the current test is holding; cleared by `stopAll` in `afterEach`. */
export const live: {
  running: ProxyServers | undefined;
  upstream: Upstream | undefined;
} = { running: undefined, upstream: undefined };

export const events: DecisionEvent[] = [];

export async function stopAll(): Promise<void> {
  await live.running?.close();
  await live.upstream?.close();
  live.running = undefined;
  live.upstream = undefined;
}

export async function boot(): Promise<{
  linearUrl: string;
  githubUrl: string;
}> {
  const upstream = await startUpstream();
  live.upstream = upstream;
  events.length = 0;
  const running = await createServers({
    signingKey: SIGNING_KEY,
    // Spelled out rather than defaulted: these specs are about the transport,
    // so they say what policy they are running without.
    isRevoked: (): boolean => false,
    emit: (ev: DecisionEvent): void => {
      events.push(ev);
    },
    linear: {
      vendorAuthHeader: `Bearer ${LINEAR_SECRET}`,
      port: 0,
      upstreamBase: upstream.base,
      narrow: passThroughNarrow,
    },
    github: {
      vendorAuthHeader: `Bearer ${GITHUB_SECRET}`,
      port: 0,
      upstreamBase: upstream.base,
      narrow: passThroughNarrow,
    },
  });
  live.running = running;
  const linear = running.linear.address() as AddressInfo;
  const github = running.github.address() as AddressInfo;
  return {
    linearUrl: `http://127.0.0.1:${String(linear.port)}`,
    githubUrl: `http://127.0.0.1:${String(github.port)}`,
  };
}

export function token(): string {
  return signDevToken({ key: SIGNING_KEY, ttlSeconds: 60 });
}
