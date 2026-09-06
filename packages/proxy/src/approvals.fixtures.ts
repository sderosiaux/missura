import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideGithub, GITHUB_OPERATIONS, narrowGithub } from "@missura/connectors-github";
import { decideZendesk, narrowZendesk, ZENDESK_OPERATIONS } from "@missura/connectors-zendesk";
import {
  MissionStore,
  verifyMissionToken,
  type CatalogDecision,
  type MissionClaims,
  type Operation,
  type Provider,
  type ResolvedScope,
} from "@missura/core";
import { expect } from "vitest";
import type { NarrowResult } from "./narrow";
import { APPROVAL_ROUTE } from "./approvals";
import type { OperationsDeps } from "./operations";
import { NOW, post } from "./operations.fixtures";
import { bodyText, harness, request, type Harness } from "./pipeline.fixtures";
import { handle } from "./pipeline";

/**
 * The rig for the approval specs (M10), beside `operations.fixtures`: a REAL
 * mission store in a temp dir — the approvals are its state, and "another
 * mission" has to be a real second mission on the same file — a mission
 * minted on it, and the shipped catalog and NARROW of the connector under
 * test, so a write is decided exactly as the CLI-wired proxy decides it.
 */

const KEY = Buffer.alloc(32, 7);
const KEYS = { signing: KEY, seal: Buffer.alloc(32, 8) };

export const DELETE_OP = "github.issue.comment.delete";
export const DELETE_PARAMS = { repo: "acme-corp/product", comment: 9001 };
export const COMMENT_PATH = "/repos/acme-corp/product/issues/comments/9001";

export const REPLY_OP = "zendesk.ticket.reply";
export const REPLY_PARAMS = { ticket: 35, body: "Thanks — we are on it." };

export const SCOPE: ResolvedScope = {
  githubRepos: [{ repo: "acme-corp/product" }, { repo: "acme-corp/infra" }],
  zendeskOrganizationIds: ["4200"],
};

const CATALOGUE: readonly Operation[] = [...GITHUB_OPERATIONS, ...ZENDESK_OPERATIONS];

export function approvalStore(): MissionStore {
  const dir = mkdtempSync(join(tmpdir(), "missura-proxy-approvals-"));
  return new MissionStore(join(dir, "missions.json"), KEYS, CATALOGUE);
}

/** A mission minted on the store, as the pipeline will see it: verified claims. */
export function mintClaims(store: MissionStore, allow: readonly string[]): MissionClaims {
  const { token } = store.create(
    {
      purpose: "m10 spec",
      actor: "tester@local",
      scope: { entity: "customer:acme" },
      ttlSeconds: 900,
      ...(allow.length === 0 ? {} : { allow }),
    },
    SCOPE,
  );
  return verifyMissionToken(token, { key: KEY, now: NOW });
}

export interface ApprovalRig {
  outer: Harness;
  connector: Harness;
  store: MissionStore;
  claims: MissionClaims;
}

export interface RigOptions {
  store?: MissionStore;
  allow?: readonly string[];
  /** The vendor double; the default answers a write with an empty 204. */
  vendor?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * The GitHub double: a comment read by id answers the comment where the
 * path says it lives — its `url` is what the destroy proves itself against
 * (L8) — and a DELETE answers as GitHub does, nothing, 204.
 */
function github(url: string, init: RequestInit): Promise<Response> {
  if ((init.method ?? "GET") === "DELETE") {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  const path = url.replace("https://api.github.com", "");
  const comment = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(path);
  const body =
    comment === null
      ? "{}"
      : JSON.stringify({
          id: Number(comment[2]),
          url: `https://api.github.com/repos/${comment[1] ?? ""}/issues/comments/${comment[2] ?? ""}`,
          body: "a comment",
        });
  return Promise.resolve(
    new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  );
}

function noContent(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 204 }));
}

function connectorHarness(
  provider: Provider,
  claims: MissionClaims,
  vendor: RigOptions["vendor"],
): Harness {
  const shared = { verifyToken: (): MissionClaims => claims, now: (): number => NOW };
  if (provider === "github") {
    return harness(
      {
        provider,
        ...shared,
        decide: (req): CatalogDecision => decideGithub(req.method, req.path, req.via),
        narrow: (req): NarrowResult =>
          narrowGithub(
            req.path,
            { githubRepos: SCOPE.githubRepos },
            { method: req.method, ...(req.via === undefined ? {} : { via: req.via }) },
          ),
      },
      vendor ?? github,
    );
  }
  return harness(
    {
      provider,
      ...shared,
      upstreamBase: "https://acme.zendesk.com",
      decide: (req): CatalogDecision => decideZendesk(req.method, req.path, req.via),
      narrow: (req): NarrowResult =>
        narrowZendesk(
          req.path,
          { zendeskOrganizationIds: [...(SCOPE.zendeskOrganizationIds ?? [])] },
          { method: req.method, ...(req.via === undefined ? {} : { via: req.via }) },
        ),
    },
    vendor ?? noContent,
  );
}

/**
 * The agent aims at the LINEAR listener (`outer`); the write runs on the
 * connector's own pipeline. `allow` defaults to the connector's gated write.
 */
export function approvalRig(provider: Provider, over: RigOptions = {}): ApprovalRig {
  const store = over.store ?? approvalStore();
  const claims = mintClaims(store, over.allow ?? [provider === "github" ? DELETE_OP : REPLY_OP]);
  const connector = connectorHarness(provider, claims, over.vendor);
  const operations: OperationsDeps = {
    catalogue: CATALOGUE,
    resolveScope: (): ResolvedScope => SCOPE,
    pipelineFor: (name) => (name === provider ? connector.deps : undefined),
    approvals: store,
  };
  connector.deps.operations = operations;
  const outer = harness({
    provider: "linear",
    verifyToken: (): MissionClaims => claims,
    now: () => NOW,
    operations,
  });
  return { outer, connector, store, claims };
}

/** `POST /missura/op/<name>` with `params`, answered by the rig's outer listener. */
export async function requestOp(
  rig: ApprovalRig,
  name: string,
  params: Record<string, unknown>,
): Promise<ReturnType<typeof handle> extends Promise<infer R> ? R : never> {
  return handle(rig.outer.deps, post(name, JSON.stringify(params)));
}

/** Opens an approval and returns its id, asserting the 202 on the way. */
export async function opened(
  rig: ApprovalRig,
  name: string,
  params: Record<string, unknown>,
): Promise<string> {
  const res = await requestOp(rig, name, params);
  expect(res.status).toBe(202);
  return (JSON.parse(bodyText(res.body)) as { id: string }).id;
}

/** `GET /missura/approvals/<id>` with the rig's own token. */
export async function poll(
  rig: ApprovalRig,
  id: string,
): Promise<{ status: number; body: string }> {
  const res = await handle(
    rig.outer.deps,
    request({ method: "GET", path: `${APPROVAL_ROUTE}${id}` }),
  );
  return { status: res.status, body: bodyText(res.body) };
}
