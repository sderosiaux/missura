import type { AddressInfo } from "node:net";
import { loadOrCreateKey } from "@missura/core";
import { expect } from "vitest";
import { writeEntityGraph, type Harness } from "./harness.fixtures";
import { run } from "./index";
import { resolveHome } from "./paths";
import type { RunningProxy } from "./run";

/**
 * The M9 readers, beside the shared rig (`milestone.fixtures`): the operator's
 * two surfaces — `missura entity show --json` and the operator plane — and
 * the shape both answer in.
 */

export interface ShownOperation {
  name: string;
  effect: string;
  system: string;
  possible: boolean;
  cause?: string;
  status?: string;
  remediation?: string;
}

export interface ShownEntity {
  entity: string;
  links: { system: string; id: string; status: string }[];
  operations: ShownOperation[];
}

/** `missura entity show <key> --json`, on the shared graph. */
export async function show(h: Harness, key: string): Promise<ShownEntity> {
  writeEntityGraph(h);
  h.out.length = 0;
  const result = await run(["entity", "show", key, "--json"], h.io);
  expect(result.code, h.err.join("\n")).toBe(0);
  return JSON.parse(h.out.join("\n")) as ShownEntity;
}

export function operation(shown: ShownEntity, name: string): ShownOperation {
  const found = shown.operations.find((op) => op.name === name);
  if (found === undefined) throw new Error(`no operation ${name} in the report`);
  return found;
}

function operatorBase(servers: RunningProxy): string {
  const { port } = servers.operator.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

/** The operator's own bearer, as `missura init` wrote it. */
function operatorBearer(h: Harness): string {
  return `Bearer ${loadOrCreateKey(resolveHome(h.io.env).operatorKeyPath).toString("hex")}`;
}

export interface MintRefusal {
  status: number;
  error: { field: string; reason: string; gap?: Record<string, unknown> };
}

/** `POST /v1/token` for an entity with a name-grant, read as the refusal it may be. */
export async function mint(
  h: Harness,
  servers: RunningProxy,
  entity: string,
  allow: readonly string[],
): Promise<MintRefusal> {
  const res = await fetch(`${operatorBase(servers)}/v1/token`, {
    method: "POST",
    headers: { authorization: operatorBearer(h), "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      authorization_details: [
        { type: "mission", purpose: "m9 proof", actor: "ops@local", scope: { entity }, ttl: 300, allow },
      ],
    }),
  });
  return { status: res.status, ...((await res.json()) as Omit<MintRefusal, "status">) };
}

/** `GET /v1/feasibility?entity=<key>` on the operator plane. */
export async function feasibility(
  h: Harness,
  servers: RunningProxy,
  entity: string,
): Promise<ShownEntity> {
  const res = await fetch(`${operatorBase(servers)}/v1/feasibility?entity=${entity}`, {
    headers: { authorization: operatorBearer(h) },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ShownEntity;
}

/** The systems a refusal body names, against the ones the mission already told the agent. */
export function systemsNamed(text: string): string[] {
  return ["linear", "github", "zendesk"].filter((system) => text.includes(system));
}
