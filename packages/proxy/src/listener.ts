import type { IncomingMessage, ServerResponse } from "node:http";
import { denialResponse } from "./deny";
import {
  handle,
  type IncomingShape,
  type PipelineDeps,
  type ResponseShape,
} from "./pipeline";

/**
 * The wire in front of one connector's pipeline: reads the request off the
 * socket under the inbound cap, hands it to `handle`, writes the answer back.
 * No policy lives here — the two refusals it produces are about the transport.
 */

/** Requests above this are refused before any policy work: 10 MB. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

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

export function listener(
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
