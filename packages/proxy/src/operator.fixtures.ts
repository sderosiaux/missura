import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  entityGraphReader,
  feasibilityReport,
  MissionStore,
  parseEntityGraph,
  resolveMissionScope,
  verifyMissionToken,
  type FeasibilityReport,
  type LinkSystem,
  type MissionClaims,
  type MissionResolution,
  type MissionScope,
} from "@missura/core";
import { startOperatorServer, type OperatorDeps } from "./operator";
import { ALL_OPERATIONS, operationCatalogue } from "./server";

/**
 * Shared test-only harness for the operator API specs (not exported by the
 * package index). Every boot gets its own state file, so a revoke in one test
 * cannot colour another.
 */
export const SIGNING_KEY = randomBytes(32);
export const SEAL_KEY = randomBytes(32);
export const OPERATOR_KEY = randomBytes(32);
export const OPERATOR_HEX = OPERATOR_KEY.toString("hex");
export const OPERATOR_BEARER = `Bearer ${OPERATOR_HEX}`;

const CONFIRMED = {
  method: "manual",
  status: "confirmed",
  confirmedBy: "ops@missura.dev",
} as const;

/**
 * The real graph shape, in memory — no file, so no operator test owns a path.
 * `customer:acme` is whole; `customer:initech` has a Linear link nobody has
 * confirmed and no GitHub link at all — the two gaps a mint can name (M9).
 */
export const GRAPH = entityGraphReader(
  parseEntityGraph(
    {
      version: 1,
      entities: {
        "customer:acme": {
          displayName: "Acme",
          domains: ["acme.example"],
          links: [
            { system: "linear", id: "c_18", evidence: "operator", ...CONFIRMED },
            {
              system: "github",
              id: "acme-corp/product",
              evidence: "operator",
              ...CONFIRMED,
            },
          ],
        },
        "customer:initech": {
          displayName: "Initech",
          domains: ["initech.example"],
          links: [
            {
              system: "linear",
              id: "c_55",
              evidence: "name matches",
              method: "inferred",
              status: "proposed",
            },
          ],
        },
      },
    },
    "operator fixtures",
  ),
);

/** What this proxy serves: two connections, no Zendesk. */
const CONNECTED: readonly LinkSystem[] = ["linear", "github"];

export interface TokenBody {
  mission_id: string;
  access_token: string;
  expires_in: number;
  proxy_origins: { linear: string; github: string };
}

export interface Operator {
  base: string;
  store: MissionStore;
}

const servers: Server[] = [];

export async function boot(): Promise<Operator> {
  const dir = mkdtempSync(join(tmpdir(), "missura-operator-"));
  // The catalogue a proxy with these two connections serves: what `allow`
  // may name (M8).
  const store = new MissionStore(
    join(dir, "missions.json"),
    { signing: SIGNING_KEY, seal: SEAL_KEY },
    operationCatalogue({ zendesk: false }),
  );
  const deps: OperatorDeps = {
    store,
    resolve: (scope: MissionScope): MissionResolution =>
      resolveMissionScope(GRAPH, scope),
    feasibility: (entity: string, allow: readonly string[]): FeasibilityReport =>
      feasibilityReport({
        reader: GRAPH,
        entity,
        catalogue: ALL_OPERATIONS,
        connected: CONNECTED,
        allow,
      }),
    operatorKey: OPERATOR_KEY,
    verifyToken: (token: string): MissionClaims =>
      verifyMissionToken(token, { key: SIGNING_KEY }),
  };
  const server = await startOperatorServer(deps, 0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}`, store };
}

export async function closeAll(): Promise<void> {
  const open = servers.splice(0, servers.length);
  await Promise.all(
    open.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
}

export function mintPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    grant_type: "client_credentials",
    authorization_details: [
      {
        type: "mission",
        purpose: "support case 42",
        actor: "ops@local",
        scope: { entity: "customer:acme" },
        ttl: 900,
        ...over,
      },
    ],
  });
}

export async function post(
  base: string,
  path: string,
  body: string,
  auth: string = OPERATOR_BEARER,
): Promise<Response> {
  return await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body,
  });
}

export async function mint(base: string): Promise<TokenBody> {
  const res = await post(base, "/v1/token", mintPayload());
  return (await res.json()) as TokenBody;
}
