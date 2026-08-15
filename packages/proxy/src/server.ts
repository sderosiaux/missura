import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { decideGithub } from "@missura/connectors-github";
import { decideLinear } from "@missura/connectors-linear";
import {
  createCursorStore,
  verifyMissionToken,
  type CatalogDecision,
  type DecisionEvent,
  type Provider,
} from "@missura/core";
import { denialResponse } from "./deny";
import type { NarrowFn } from "./narrow";
import {
  handle,
  type IncomingShape,
  type PipelineDeps,
  type ResponseShape,
} from "./pipeline";

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
  /**
   * The connector's NARROW. Required: a connection wired without one would
   * pass every cataloged request through unnarrowed, and a missing policy
   * input must never read as PASS. A connection that genuinely narrows nothing
   * says so out loud, with `passThroughNarrow`.
   */
  narrow: NarrowFn;
}

export interface ProxyConfig {
  signingKey: Buffer;
  emit(ev: DecisionEvent): void;
  /**
   * The mission store's revocation list. Required: defaulting it to "nothing
   * is revoked" would turn a wiring mistake into a proxy that honours every
   * called-back mission until expiry.
   */
  isRevoked: (jti: string) => boolean;
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

function send(res: ServerResponse, out: ResponseShape): void {
  const body = Buffer.from(out.body);
  res.writeHead(out.status, {
    ...out.headers,
    "content-length": String(body.length),
  });
  res.end(body);
}

const REQUEST_TOO_LARGE_REASON = "request too large";

/**
 * The two refusals that never reach the pipeline — the inbound cap and a
 * transport-level failure — take the same vendor-shaped, actionable form as
 * every other one (SPEC §4.8bis). An SDK does not know which layer refused it,
 * so a bare `{error:{code}}` here would be the one denial it cannot parse.
 */
function transportDenial(
  deps: PipelineDeps,
  status: number,
  code: "missura_request_too_large" | "missura_internal",
  reason: string,
): ResponseShape {
  return denialResponse(deps.provider, { status, code, reason });
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
            transportDenial(
              deps,
              413,
              "missura_request_too_large",
              REQUEST_TOO_LARGE_REASON,
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
        send(res, await handle(deps, incoming));
      } catch {
        // Transport-level failure (socket error, malformed request): fail closed.
        send(
          res,
          transportDenial(
            deps,
            500,
            "missura_internal",
            "missura failed before the request could be decided",
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
    // One store per connection: a cursor is a position in ONE vendor's
    // collection, and a handle that crossed connections would name a position
    // in a collection the other vendor never has.
    cursors: createCursorStore(),
    verifyToken: (token) =>
      verifyMissionToken(token, { key: config.signingKey }),
    decide,
    isRevoked: config.isRevoked,
    narrow: connection.narrow,
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
