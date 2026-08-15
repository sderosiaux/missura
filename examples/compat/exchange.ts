import {
  classify,
  type Classification,
  type Exchange,
  type OperationSpec,
} from "./classify";
import { call, notIssued, pace } from "./http";
import { announced, graphqlSignature, operationCall } from "./upstream";
import type { Recorder } from "./upstream";
import type { Vendor } from "./vendor-shapes";

/**
 * HALF B — one catalogued operation, called twice.
 *
 * The same request bytes go to the vendor with the vendor's credential, and to
 * missura with a mission token. Everything that differs between the two answers
 * is then classified, and exactly one category fails.
 *
 * The calls are RAW HTTP rather than SDK method calls, and that is a deliberate
 * narrowing of what this half claims. An SDK parses a body into objects, so it
 * cannot show which BYTES changed — and byte shape is the whole comparison
 * here. That the official typed SDKs work through the proxy is proven
 * elsewhere, against a running proxy, by `examples/m3-proof`; this half proves
 * something different and more mechanical: that what comes back is still the
 * vendor's own body, minus only what a connector declares it removes.
 */

export interface Operation {
  spec: OperationSpec;
  method: string;
  /** Path and query, as an SDK consumer would send it. Ids already bound. */
  path: string;
  body?: string;
  /**
   * The vendor call this suite refuses to make itself. Set on every REFUSED
   * operation: those are account-wide listings, exports and admin surfaces, and
   * issuing one directly to see what it would have returned would do the very
   * thing the catalog refuses on the human's production tenant.
   */
  skipDirect?: boolean;
  /**
   * Declared, never issued — by EITHER half.
   *
   * For an operation whose verdict depends on the MISSION rather than on the
   * request: a repository the mission holds by path refuses routes that the
   * same repository, held whole, serves. This run mints one mission, so it
   * cannot observe both; issuing these under the mission it does have would
   * record a classification for a mission nobody ran. They stay in the manifest
   * — the coverage claim is a property of the connector, not of a run — and
   * read `not_observed`, which the manifest already keeps distinct from
   * `compatible` for exactly this reason.
   */
  declaredOnly?: boolean;
}

/** Where a vendor's own API lives, and what a direct call has to carry. */
export interface VendorEndpoint {
  base: string;
  headers: Record<string, string>;
}

export interface Observation {
  operation: string;
  vendor: Vendor;
  classification: Classification;
  reasons: string[];
  unsafe: string[];
  notes: string[];
  objectsRemoved: number;
  /** `METHOD path` as the agent asked, ids redacted by the report, not here. */
  agentRequest: string;
  /** `METHOD path` as the proxy forwarded it, observed on the wire. */
  upstream?: string;
  /** Every upstream call this one agent request cost, probes and refills too. */
  upstreamCalls: string[];
  /** Status pair, so a reader does not have to infer it from the prose. */
  directStatus: number;
  proxiedStatus: number;
}

const PACE_MS = 400;

/**
 * The agent's request in the SAME spelling the recorder uses for the proxy's
 * upstream call — otherwise every operation would read as rewritten, because
 * the two strings were built by different code.
 */
function requestOf(operation: Operation): string {
  const signature = graphqlSignature(operation.body);
  const target = `${operation.method.toUpperCase()} ${operation.path}`;
  return signature === undefined ? target : `${target} ${signature}`;
}

export interface ExchangeContext {
  vendor: Vendor;
  endpoint: VendorEndpoint;
  /** `http://127.0.0.1:<port>` for this connection's in-process listener. */
  origin: string;
  token: string;
  recorder: Recorder;
}

async function direct(
  operation: Operation,
  ctx: ExchangeContext,
): Promise<Exchange> {
  if (operation.skipDirect === true) return notIssued();
  await pace(PACE_MS);
  return call(
    announced(`direct   · ${operation.spec.operation}`, {
      method: operation.method,
      url: `${ctx.endpoint.base}${operation.path}`,
      headers: ctx.endpoint.headers,
      ...(operation.body === undefined ? {} : { body: operation.body }),
    }),
  );
}

/**
 * The same request, aimed at missura. The mission token replaces the vendor
 * credential and NOTHING else changes — same method, same path, same body, same
 * accept header — because a difference in the request would be a difference this
 * half then attributed to the proxy.
 */
async function proxied(
  operation: Operation,
  ctx: ExchangeContext,
): Promise<Exchange> {
  await pace(PACE_MS);
  const headers: Record<string, string> = { ...ctx.endpoint.headers };
  headers.authorization = `Bearer ${ctx.token}`;
  return call(
    announced(`missura  · ${operation.spec.operation}`, {
      method: operation.method,
      url: `${ctx.origin}${operation.path}`,
      headers,
      ...(operation.body === undefined ? {} : { body: operation.body }),
    }),
  );
}

export async function runOperation(
  operation: Operation,
  ctx: ExchangeContext,
): Promise<Observation> {
  const agentRequest = requestOf(operation);
  const directAnswer = await direct(operation, ctx);
  // Drained before the proxied call so the recording holds that call's upstream
  // traffic and nothing left over from an earlier operation.
  ctx.recorder.take();
  const proxiedAnswer = await proxied(operation, ctx);
  const calls = ctx.recorder.take();
  const upstream = operationCall(calls);

  const result = classify({
    spec: operation.spec,
    direct: directAnswer,
    proxied: proxiedAnswer,
    upstream,
    agentRequest,
  });
  return {
    operation: operation.spec.operation,
    vendor: ctx.vendor,
    classification: result.classification,
    reasons: result.reasons,
    unsafe: result.unsafe,
    notes: result.notes,
    objectsRemoved: result.objectsRemoved,
    agentRequest,
    ...(upstream === undefined ? {} : { upstream }),
    upstreamCalls: calls,
    directStatus: directAnswer.status,
    proxiedStatus: proxiedAnswer.status,
  };
}
