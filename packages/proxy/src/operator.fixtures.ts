import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MissionStore,
  resolveScope,
  verifyMissionToken,
  type EntityMapping,
  type MissionClaims,
  type MissionScope,
  type ResolvedScope,
} from "@missura/core";
import { startOperatorServer, type OperatorDeps } from "./operator";

/**
 * Shared test-only harness for the operator API specs (not exported by the
 * package index). Every boot gets its own state file, so a revoke in one test
 * cannot colour another.
 */
export const SIGNING_KEY = randomBytes(32);
export const OPERATOR_KEY = randomBytes(32);
export const OPERATOR_HEX = OPERATOR_KEY.toString("hex");
export const OPERATOR_BEARER = `Bearer ${OPERATOR_HEX}`;

export const ENTITIES = new Map<string, EntityMapping>([
  [
    "customer:acme",
    { linearCustomerId: "c_18", githubRepos: ["acme-corp/product"] },
  ],
]);

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
  const store = new MissionStore(join(dir, "missions.json"), SIGNING_KEY);
  const deps: OperatorDeps = {
    store,
    resolve: (scope: MissionScope): ResolvedScope =>
      resolveScope(ENTITIES, scope),
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
        scope: { customer: "acme" },
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
