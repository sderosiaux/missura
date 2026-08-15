import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { decideGithub } from "@missura/connectors-github";
import { decideLinear } from "@missura/connectors-linear";
import {
  verifyMissionToken,
  type CatalogDecision,
  type DecisionEvent,
  type Provider,
} from "@missura/core";
import { passThroughNarrow, type NarrowFn } from "./narrow";
import { handle, type IncomingShape, type PipelineDeps } from "./pipeline";

export const DEFAULT_LINEAR_PORT = 8481;
export const DEFAULT_GITHUB_PORT = 8482;
export const DEFAULT_LINEAR_UPSTREAM = "https://api.linear.app";
export const DEFAULT_GITHUB_UPSTREAM = "https://api.github.com";
/** Requests above this are refused before any policy work: 10 MB. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface ConnectionConfig {
  /** Built from the vault once at boot; it never travels back to the agent. */
  vendorAuthHeader: string;
  port?: number;
  upstreamBase?: string;
  /** The connector's NARROW; absent means pass-through (catalog only). */
  narrow?: NarrowFn;
}

export interface ProxyConfig {
  signingKey: Buffer;
  emit(ev: DecisionEvent): void;
  /**
   * The mission store's revocation list. Absent means nothing is revoked —
   * true only for a proxy booted without an operator plane.
   */
  isRevoked?: (jti: string) => boolean;
  linear: ConnectionConfig;
  github: ConnectionConfig;
  /** Overridable so tests can drive an in-process vendor double. */
  fetchImpl?: typeof fetch;
}

export interface ProxyServers {
  linear: Server;
  github: Server;
  close(): Promise<void>;
}

function requestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") out[name.toLowerCase()] = value;
    else if (Array.isArray(value)) out[name.toLowerCase()] = value.join(", ");
  }
  return out;
}

/**
 * Buffers the body up to the cap. Above it the request is drained rather than
 * destroyed so the client can still read the 413 instead of a reset socket.
 */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      resolve(overflow ? undefined : Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
): void {
  res.writeHead(status, { ...headers, "content-length": String(body.length) });
  res.end(body);
}

/**
 * The cap is a policy decision like any other, so it lands in the audit log
 * too — an oversized request that left no trace would be a blind spot.
 */
function emitTooLarge(deps: PipelineDeps, startedAt: number): void {
  const now = deps.now?.() ?? Date.now();
  deps.emit({
    ts: new Date(now).toISOString(),
    provider: deps.provider,
    operation: "unknown",
    action: "unknown",
    decision: "deny",
    reason: "request too large",
    missionId: "unknown",
    latencyMs: Math.max(0, now - startedAt),
  });
}

function listener(
  deps: PipelineDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async (): Promise<void> => {
      const startedAt = deps.now?.() ?? Date.now();
      try {
        const body = await readBody(req);
        if (body === undefined) {
          emitTooLarge(deps, startedAt);
          send(
            res,
            413,
            { "content-type": "application/json" },
            Buffer.from(
              JSON.stringify({ error: { code: "missura_request_too_large" } }),
              "utf8",
            ),
          );
          return;
        }
        const incoming: IncomingShape = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          headers: requestHeaders(req),
          body,
        };
        const out = await handle(deps, incoming);
        send(res, out.status, out.headers, Buffer.from(out.body));
      } catch {
        // Transport-level failure (socket error, malformed request): fail closed.
        send(
          res,
          500,
          { "content-type": "application/json" },
          Buffer.from(
            JSON.stringify({ error: { code: "missura_internal" } }),
            "utf8",
          ),
        );
      }
    })();
  };
}

function deps(
  provider: Provider,
  config: ProxyConfig,
  connection: ConnectionConfig,
  decide: PipelineDeps["decide"],
  defaultUpstream: string,
): PipelineDeps {
  return {
    provider,
    verifyToken: (token) =>
      verifyMissionToken(token, { key: config.signingKey }),
    decide,
    isRevoked: (jti: string): boolean => config.isRevoked?.(jti) ?? false,
    narrow: connection.narrow ?? passThroughNarrow,
    vendorAuthHeader: (): string => connection.vendorAuthHeader,
    upstreamBase: connection.upstreamBase ?? defaultUpstream,
    fetchImpl: config.fetchImpl ?? fetch,
    emit: (ev): void => {
      config.emit(ev);
    },
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

/**
 * One listener per connector: an agent points a vendor SDK at a port and gets
 * that vendor's catalog, its credential and nothing else. Separate ports are
 * an addressing convenience, not the boundary — a token aimed at the wrong
 * port is refused by the pipeline's `claims.connections` check, which is what
 * actually stops the replay.
 */
export async function createServers(
  config: ProxyConfig,
): Promise<ProxyServers> {
  const linear = createServer(
    listener(
      deps(
        "linear",
        config,
        config.linear,
        (req): CatalogDecision => decideLinear(req.method, req.path, req.body),
        DEFAULT_LINEAR_UPSTREAM,
      ),
    ),
  );
  const github = createServer(
    listener(
      deps(
        "github",
        config,
        config.github,
        (req): CatalogDecision => decideGithub(req.method, req.path),
        DEFAULT_GITHUB_UPSTREAM,
      ),
    ),
  );

  await listen(linear, config.linear.port ?? DEFAULT_LINEAR_PORT);
  try {
    await listen(github, config.github.port ?? DEFAULT_GITHUB_PORT);
  } catch (err) {
    await shutdown(linear);
    throw err;
  }

  return {
    linear,
    github,
    close: async (): Promise<void> => {
      await Promise.all([shutdown(linear), shutdown(github)]);
    },
  };
}
