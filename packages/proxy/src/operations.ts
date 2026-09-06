import {
  operationAllowed,
  OperationParameterError,
  scopeSatisfies,
  type CatalogDecision,
  type MissionClaims,
  type MissionScope,
  type Operation,
  type OperationStep,
  type Provider,
  type ResolvedScope,
  type ViaOperation,
} from "@missura/core";
import {
  ACTION_REASON,
  CONNECTION_REASON,
  claimsDenial,
  emitEvent,
  type RequestContext,
} from "./audit";
import { actionDenial, connectionDenial, denialResponse } from "./deny";
import type { PipelineDeps } from "./pipeline";
import { wasReduced } from "./reduced";
import { JSON_HEADERS, type IncomingShape, type ResponseShape } from "./transport";

/**
 * THE OPERATION EXECUTOR (M7): `POST /missura/op/<name>`, bearer = the mission
 * token, body = the parameters as one JSON object (or empty).
 *
 * Missura executing an operation is not missura bypassing itself. The executor
 * owns no vendor call: it plans the requests the agent could have sent, builds
 * each one AS IF the agent had sent it — same bearer, same trace — and hands it
 * to the connector's own `handle`, on the connector's own deps. The catalog,
 * NARROW, the parent proof, FILTER, REFILL, the cursor swap and the audit
 * record all run, unchanged. An executor that called `fetch` would sit outside
 * what it enforces; this one cannot reach one byte the pipeline would refuse.
 *
 * Served on ANY listener, like introspection, and before the connection check
 * for the same reason: the route is missura's, not the vendor's, and the inner
 * calls land on the right connector whatever port the agent aimed at.
 */
export const OPERATION_ROUTE = "/missura/op/";

/** The audit line for the operation itself; the inner calls write their own. */
const OPERATION_ROUTE_NAME = "missura.op";

const UNKNOWN_OPERATION_REASON = "operation not in the missura catalogue";
const INVALID_PARAMETERS_REASON = "operation parameters are not a JSON object";
const UNSATISFIED_REASON = "mission resolves to no target for this operation";
const STEP_REFUSED_REASON = "an inner vendor call was refused";

export interface OperationsDeps {
  /**
   * Every operation this proxy can run, across its connectors. Introspection
   * filters it down to what the mission reaches; nothing lists it whole to an
   * agent.
   */
  catalogue: readonly Operation[];
  /**
   * The mission's scope, resolved to vendor targets — the same resolution the
   * connectors' NARROW runs. A plan takes its targets from here and from
   * nowhere else. `undefined` means the scope no longer resolves, which refuses.
   */
  resolveScope(scope: MissionScope): ResolvedScope | undefined;
  /**
   * The pipeline of one connector, by name: its catalog, NARROW, credential
   * and origin. Absent for a connector this proxy has no listener for, whose
   * operations are then not in the catalogue either.
   */
  pipelineFor(connector: Provider): PipelineDeps | undefined;
}

/**
 * How the executor runs an inner request: `handle`, handed in by the
 * pipeline. `via` is the in-process context that names the operation — and,
 * for a write, the only thing that opens its route (M8). It is built here,
 * from the catalogue entry the executor already resolved, and never from
 * anything the outer request carried.
 */
export type RunInner = (
  deps: PipelineDeps,
  req: IncomingShape,
  via: ViaOperation,
) => Promise<ResponseShape>;

/**
 * The operation's result. Small on purpose:
 *   - `results` holds one entry per inner call, in plan order — each the
 *     vendor's own answer as the pipeline returned it (parsed when it is JSON,
 *     the text otherwise), so the agent reads shapes it already knows;
 *   - `reduced` is present, and `true`, exactly when at least one inner answer
 *     carried the M6 marker. One boolean for the whole operation, never which
 *     step and never how much: a marker per entry would map where the foreign
 *     objects sat.
 */
export interface OperationResult {
  operation: string;
  effect: Operation["effect"];
  results: readonly unknown[];
  reduced?: true;
}

/** The operation name the request targets, or `undefined` when it is not the route. */
export function operationName(req: IncomingShape): string | undefined {
  if (req.method.toUpperCase() !== "POST") return undefined;
  const path = req.path.split("?")[0] ?? "";
  if (!path.startsWith(OPERATION_ROUTE)) return undefined;
  const name = path.slice(OPERATION_ROUTE.length);
  return name.length === 0 ? undefined : name;
}

/** The body as a parameter object; `undefined` when it is anything else. */
function readParams(body: string): Readonly<Record<string, unknown>> | undefined {
  if (body.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The inner request, as the agent would have sent it: its own bearer, its own
 * trace context, and a content type only where there is a body. Nothing else
 * of the outer request travels — the outer body is parameters, not payload.
 */
function innerRequest(
  outer: IncomingShape,
  step: { method: string; path: string; body: string },
): IncomingShape {
  const headers: Record<string, string> = {};
  const authorization = outer.headers.authorization;
  if (authorization !== undefined) headers.authorization = authorization;
  const traceparent = outer.headers.traceparent;
  if (traceparent !== undefined) headers.traceparent = traceparent;
  if (step.body.length > 0) headers["content-type"] = "application/json";
  return { method: step.method, path: step.path, headers, body: step.body };
}

function parsed(body: string | Uint8Array): unknown {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function verdictFor(op: Operation): CatalogDecision {
  return {
    decision: "allow",
    operation: OPERATION_ROUTE_NAME,
    action: op.effect,
    reason: "operation executed through the pipeline",
  };
}

/**
 * What the refusal tells the agent it lacks: the verb for a read, the NAME
 * for a write — the grant an operator would actually have to make.
 */
function grantFor(op: Operation): string {
  return op.effect === "read" ? "read" : op.name;
}

/**
 * The plan, or the parameter it could not plan from. Only the typed error is
 * an answer; anything else a plan throws is a bug and stays a 500 upstream.
 */
function planned(
  op: Operation,
  scope: ResolvedScope,
  params: Readonly<Record<string, unknown>>,
): { steps: readonly OperationStep[] } | { invalid: string } {
  try {
    return { steps: op.plan(scope, params) };
  } catch (err) {
    if (err instanceof OperationParameterError) return { invalid: err.message };
    throw err;
  }
}

const UNKNOWN_VERDICT: CatalogDecision = {
  decision: "deny",
  operation: OPERATION_ROUTE_NAME,
  action: "unknown",
  reason: UNKNOWN_OPERATION_REASON,
};

/**
 * Runs one operation for a verified, live mission. `run` is the pipeline's
 * own `handle`, injected rather than imported so this module never grows a
 * second way to reach a vendor.
 */
export async function executeOperation(
  deps: PipelineDeps,
  req: IncomingShape,
  ctx: RequestContext,
  claims: MissionClaims,
  name: string,
  run: RunInner,
): Promise<ResponseShape> {
  const opCtx: RequestContext = { ...ctx, viaOperation: name };
  const mission = { claims, now: ctx.startedAt };
  const op = deps.operations.catalogue.find((entry) => entry.name === name);
  const target = op === undefined ? undefined : deps.operations.pipelineFor(op.connector);
  // Unknown name, or a connector with no pipeline here: the same refusal, in
  // the listener's own envelope, naming neither the name nor a connector.
  if (op === undefined || target === undefined) {
    emitEvent(deps, opCtx, UNKNOWN_VERDICT);
    return denialResponse(deps.provider, {
      status: 404,
      code: "missura_operation_unknown",
      reason: UNKNOWN_OPERATION_REASON,
      ...mission,
    });
  }
  const verdict = verdictFor(op);
  // The two claims checks the raw call would hit first, decided here with the
  // same builders and in the connector's own envelope — so the refusal an
  // operation gets is the refusal the raw call gets, byte for byte.
  if (!claims.connections.includes(op.connector)) {
    emitEvent(deps, opCtx, claimsDenial(verdict, CONNECTION_REASON));
    return denialResponse(op.connector, connectionDenial(mission));
  }
  // A read by the verb, a write by its exact name (`operationAllowed`) —
  // decided here, before a plan exists, so an ungranted write costs nothing.
  if (!operationAllowed(claims, op)) {
    emitEvent(deps, opCtx, claimsDenial(verdict, ACTION_REASON));
    return denialResponse(op.connector, actionDenial(mission, grantFor(op)));
  }
  const params = readParams(req.body);
  if (params === undefined) {
    emitEvent(deps, opCtx, claimsDenial(verdict, INVALID_PARAMETERS_REASON));
    return denialResponse(deps.provider, {
      status: 400,
      code: "missura_invalid_parameters",
      reason: INVALID_PARAMETERS_REASON,
      ...mission,
    });
  }
  // Resolved here only to PLAN — which targets to ask about. Whether the
  // mission may is re-decided per step by the connector's NARROW, which
  // resolves the same scope again on its own.
  const scope = deps.operations.resolveScope(claims.scope);
  if (scope === undefined || !scopeSatisfies(scope, op.needs)) {
    emitEvent(deps, opCtx, claimsDenial(verdict, UNSATISFIED_REASON));
    return denialResponse(op.connector, {
      status: 404,
      code: "missura_out_of_mission_scope",
      reason: UNSATISFIED_REASON,
      scopeSize: 0,
      ...mission,
    });
  }

  const plan = planned(op, scope, params);
  if ("invalid" in plan) {
    emitEvent(deps, opCtx, claimsDenial(verdict, plan.invalid));
    return denialResponse(deps.provider, {
      status: 400,
      code: "missura_invalid_parameters",
      reason: plan.invalid,
      ...mission,
    });
  }

  const results: unknown[] = [];
  let reduced = false;
  for (const step of plan.steps) {
    const answer = await run(target, innerRequest(req, step), { operation: op.name });
    // A refused step is the operation's answer, untouched: the pipeline built
    // it in the vendor's shape with the mission's remediation, and rewrapping
    // it would be the one refusal an SDK behind this route could not parse.
    if (answer.status < 200 || answer.status >= 300) {
      emitEvent(deps, opCtx, claimsDenial(verdict, STEP_REFUSED_REASON));
      return answer;
    }
    reduced = reduced || wasReduced(op.connector, answer);
    results.push(parsed(answer.body));
  }
  emitEvent(deps, opCtx, verdict);
  const body: OperationResult = {
    operation: op.name,
    effect: op.effect,
    results,
    ...(reduced ? { reduced: true } : {}),
  };
  return { status: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}
