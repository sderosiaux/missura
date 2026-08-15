import type {
  CatalogDecision,
  DecisionEvent,
  MissionClaims,
} from "@missura/core";
import type { IncomingShape, PipelineDeps } from "./pipeline";

/**
 * Shared test-only harness for the pipeline specs (not exported by the package
 * index). The fake vendor is an internal double: the proxy never ships one.
 */
export const VENDOR_SECRET = "vendor-super-secret-key-42";
export const VENDOR_HEADER = `Bearer ${VENDOR_SECRET}`;

export const CLAIMS: MissionClaims = {
  id: "msn_dev",
  purpose: "test",
  scope: {},
  connections: ["linear", "github"],
  allow: ["read"],
  jti: "jti-1",
  iat: 0,
  exp: 9_999_999_999,
};

export const ALLOW: CatalogDecision = {
  decision: "allow",
  operation: "repos.get",
  action: "read",
  reason: "allowlisted route",
};

export const DENY: CatalogDecision = {
  decision: "deny",
  operation: "unknown",
  action: "unknown",
  reason: "path /user is not in the GitHub read catalog",
};

export interface Harness {
  deps: PipelineDeps;
  events: DecisionEvent[];
  calls: { url: string; init: RequestInit }[];
  fetchCount: () => number;
}

export function bodyText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

export function harness(
  over: Partial<PipelineDeps> = {},
  response?: () => Promise<Response>,
): Harness {
  const events: DecisionEvent[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      init: init ?? {},
    });
    return response === undefined
      ? new Response("upstream ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })
      : await response();
  };

  const deps: PipelineDeps = {
    provider: "github",
    verifyToken: (): MissionClaims => CLAIMS,
    decide: (): CatalogDecision => ALLOW,
    vendorAuthHeader: (): string => VENDOR_HEADER,
    upstreamBase: "https://api.github.com",
    fetchImpl,
    emit: (ev: DecisionEvent): void => {
      events.push(ev);
    },
    ...over,
  };
  return { deps, events, calls, fetchCount: (): number => calls.length };
}

export function request(over: Partial<IncomingShape> = {}): IncomingShape {
  return {
    method: "GET",
    path: "/repos/octocat/hello-world",
    headers: {
      authorization: "Bearer msr_mission_token",
      host: "localhost:8482",
    },
    body: "",
    ...over,
  };
}
