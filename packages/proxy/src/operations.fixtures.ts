import type {
  MissionClaims,
  Operation,
  OperationStep,
  ResolvedScope,
} from "@missura/core";
import type { NarrowFn } from "./narrow";
import type { OperationsDeps } from "./operations";
import { OPERATION_ROUTE } from "./operations";
import {
  bodyText,
  CLAIMS,
  harness,
  request,
  type Harness,
} from "./pipeline.fixtures";
import type { IncomingShape, ResponseShape } from "./transport";

/**
 * Shared rig for the operation specs (not exported by the package index):
 * three listeners on one catalogue, so an operation aimed at one connector's
 * port can be shown to run on another connector's pipeline.
 */

export const NOW = 1_700_000_000_000;

export const SCOPE: ResolvedScope = {
  linearCustomerId: "c_18",
  githubRepos: [{ repo: "acme-corp/product" }, { repo: "acme-corp/infra" }],
  zendeskOrganizationIds: ["4200"],
};

/** One read on GitHub: one step per repository, the way the real one plans. */
export const GITHUB_ISSUES: Operation = {
  name: "github.issues.for_entity",
  connector: "github",
  effect: "read",
  needs: "github.repo",
  plan: (scope): readonly OperationStep[] =>
    scope.githubRepos.map((entry) => ({
      method: "GET",
      path: `/repos/${entry.repo}/issues?state=open`,
      body: "",
    })),
};

export const LINEAR_QUERY = '{"query":"{ issues { nodes { id } } }"}';

/** One read on Linear, so a connector the mission lacks can be asked for. */
export const LINEAR_ISSUES: Operation = {
  name: "linear.issues.for_entity",
  connector: "linear",
  effect: "read",
  needs: "linear.customer",
  plan: (): readonly OperationStep[] => [
    { method: "POST", path: "/graphql", body: LINEAR_QUERY },
  ],
};

export const CATALOGUE: readonly Operation[] = [GITHUB_ISSUES, LINEAR_ISSUES];

/**
 * A NARROW that leaves a mark: the path it lets through is rewritten, so the
 * vendor double can tell a call that went through NARROW from one that did not.
 */
export const MARKING_NARROW: NarrowFn = (req) => ({
  decision: "allow",
  path: `${req.path}&narrowed=1`,
});

export interface Rig {
  outer: Harness;
  github: Harness;
  linear: Harness;
}

/**
 * The agent aims at the LINEAR listener (`outer`); a GitHub operation must run
 * on the GITHUB one — its catalog, its NARROW, its credential — whatever port
 * the agent chose. `linear` is the connector a narrow mission can be shown to
 * lack.
 */
export function rig(
  over: {
    claims?: MissionClaims;
    githubNarrow?: NarrowFn;
    resolveScope?: OperationsDeps["resolveScope"];
  } = {},
): Rig {
  const claims = over.claims ?? CLAIMS;
  const github = harness({
    provider: "github",
    verifyToken: (): MissionClaims => claims,
    narrow: over.githubNarrow ?? MARKING_NARROW,
    now: () => NOW,
  });
  const linear = harness({
    provider: "linear",
    verifyToken: (): MissionClaims => claims,
    now: () => NOW,
  });
  const operations: OperationsDeps = {
    catalogue: CATALOGUE,
    resolveScope: over.resolveScope ?? ((): ResolvedScope => SCOPE),
    pipelineFor: (connector) => {
      if (connector === "github") return github.deps;
      return connector === "linear" ? linear.deps : undefined;
    },
  };
  github.deps.operations = operations;
  linear.deps.operations = operations;
  const outer = harness({
    provider: "linear",
    verifyToken: (): MissionClaims => claims,
    now: () => NOW,
    operations,
  });
  return { outer, github, linear };
}

export const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

export function post(name: string, body = ""): IncomingShape {
  return request({
    method: "POST",
    path: `${OPERATION_ROUTE}${name}`,
    headers: {
      authorization: "Bearer msr_mission_token",
      "content-type": "application/json",
      traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01`,
    },
    body,
  });
}

export interface OperationResultBody {
  operation: string;
  effect: string;
  results: unknown[];
  reduced?: boolean;
}

export function result(res: ResponseShape): OperationResultBody {
  return JSON.parse(bodyText(res.body)) as OperationResultBody;
}
