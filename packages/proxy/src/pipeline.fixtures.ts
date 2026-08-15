import { createCursorStore } from "@missura/core";
import type {
  CatalogDecision,
  DecisionEvent,
  MissionClaims,
  MissuraDenial,
} from "@missura/core";
import { passThroughNarrow } from "./narrow";
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
  actor: "tester@local",
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

/**
 * The missura block, read out of the vendor envelope that carries it — a
 * refusal is a GitHub REST error with a `missura` key, or a GraphQL error with
 * the block under `extensions.missura` (SPEC §4.8bis). Reading it this way is
 * the assertion: a block a test can only reach by parsing the vendor shape is
 * a block an SDK can reach too.
 */
export function restDenial(body: string | Uint8Array): MissuraDenial {
  return (JSON.parse(bodyText(body)) as { missura: MissuraDenial }).missura;
}

export function graphqlDenial(body: string | Uint8Array): MissuraDenial {
  const parsed = JSON.parse(bodyText(body)) as {
    errors: { extensions: { missura: MissuraDenial } }[];
  };
  const first = parsed.errors[0];
  if (first === undefined) throw new Error("no GraphQL error in the envelope");
  return first.extensions.missura;
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
    isRevoked: (): boolean => false,
    narrow: passThroughNarrow,
    cursors: createCursorStore(),
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
