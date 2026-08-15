/**
 * Wire-level helpers shared by the pipeline: what crosses to the vendor, what
 * comes back, and how much of it. No policy lives here — these decide shape
 * and size, never allow or deny.
 */

export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json",
};

/**
 * Headers the proxy never forwards. `authorization` is replaced by the vendor
 * credential and `host` must be recomputed by the client for the upstream
 * origin; the rest are hop-by-hop or connection-scoped and would describe the
 * agent's connection, not ours (a stale `content-length` in particular would
 * contradict the body we re-send). `accept-encoding` is dropped so the fetch
 * implementation owns the negotiation — we hand back a decoded body without a
 * `content-encoding` header. `traceparent` is deliberately absent: the agent's
 * trace context must reach the vendor so one request is one trace end to end.
 */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

/** The only upstream response headers echoed back: no cookies, no vendor metadata. */
export const FORWARDED_RESPONSE_HEADERS: readonly string[] = ["content-type"];

/**
 * Upstream responses are capped at 10 MB (SPEC: JSON ≤ 10 MB), the same cap
 * the inbound request gets. A vendor is not a trusted size: buffering whatever
 * it sends would let one response take the proxy's memory with it.
 */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const BEARER = "bearer ";

export function errorBody(code: string, reason?: string): string {
  return JSON.stringify({
    error: reason === undefined ? { code } : { code, reason },
  });
}

export function bearerToken(
  headers: Record<string, string>,
): string | undefined {
  const raw = headers.authorization;
  if (raw === undefined) return undefined;
  if (!raw.toLowerCase().startsWith(BEARER)) return undefined;
  const token = raw.slice(BEARER.length).trim();
  return token.length === 0 ? undefined : token;
}

export function upstreamHeaders(
  headers: Record<string, string>,
  vendorAuthHeader: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase()))
      out[name.toLowerCase()] = value;
  }
  out.authorization = vendorAuthHeader;
  return out;
}

export function hasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

/**
 * Reads at most `MAX_RESPONSE_BYTES`; `undefined` means the cap was crossed.
 * A declared `content-length` above the cap is refused before a single byte is
 * read, and a chunked body is abandoned the moment it crosses — an oversized
 * response is never fully buffered, which is the point of the cap.
 */
export async function readCapped(
  response: Response,
): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
