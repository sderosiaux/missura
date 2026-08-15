import type {
  CatalogDecision,
  MissionClaims,
  ParentProof,
  ParentProofStore,
} from "@missura/core";
import { claimsDenial, emitEvent, type RequestContext } from "./audit";
import { isOwned } from "./filter-owner";
import { forward, upstreamTarget, type ForwardDeps } from "./forward";
import { scopeDenial, type NarrowResult } from "./narrow";
import type { IncomingShape } from "./transport";

/**
 * The PARENT PROOF stage: one extra vendor round trip that establishes a child
 * object's owner when the child's own response cannot.
 *
 * It is the request-side twin of the response FILTER. The filter asks "does
 * this object name an owner the mission covers"; for a Zendesk ticket comment,
 * a Linear comment or an attachment there is no such field anywhere in the
 * answer, and the only link to a scopable object is the id in the request path.
 * So the connector points at the parent, the proxy fetches it, reads the owner
 * there, and compares it against the mission's own set.
 *
 * Three properties hold it together:
 *
 *   - the probe goes out through the SAME `forward` as everything else, so
 *     credential injection, the header allowlist, the response cap and the
 *     audit record stay in one place, and the audit shows the real vendor load
 *     one agent request caused;
 *   - the probe faces the catalog and the mission's own allow-list before it is
 *     made. A connector that pointed a probe at an uncataloged route would
 *     otherwise have found its way around deny-by-default;
 *   - every way of failing is ONE failure. Foreign owner, missing owner,
 *     unparseable body, 404, 502, a probe we refused to make — the caller gets
 *     `false` and nothing else, so it cannot build a different answer for a
 *     ticket that exists than for one that does not.
 *
 * SIDE-CHANNEL DISCIPLINE, stated rather than implied. Nothing about a served
 * response changes with whether a probe happened: no header, no status, no
 * marker in the body, and the refusal is built from mission-only inputs. Two
 * residuals are KNOWN and accepted:
 *   - TIMING. A first access costs a round trip; a memoized one does not. An
 *     agent that measures its own latency can tell them apart. Closing it would
 *     mean padding every response to the slow path, which this proxy does not
 *     do — and the fact it would learn ("I have read this ticket before") is
 *     already the agent's own;
 *   - the vendor's rate-limit budget relayed on the child's answer is one call
 *     lower on a first access, for the same reason and with the same reading.
 *     REFILL makes the same tradeoff, in the other direction.
 */

/** The audit reason for every parent-proof refusal, whatever failed. */
export const PARENT_PROOF_REASON = "parent not proven in mission scope";

export interface ParentProofDeps extends ForwardDeps {
  /**
   * The connector's catalog. Shared with the pipeline so a probe is decided by
   * exactly the rules the agent's own request was.
   */
  decide(req: { method: string; path: string; body: string }): CatalogDecision;
  /**
   * Which parents this mission has already proven. Required: defaulting it away
   * would either re-probe on every request or, worse, invite a caller to skip
   * the stage entirely.
   */
  proofs: ParentProofStore;
}

export interface ParentProofCall {
  proof: ParentProof;
  /**
   * The mission's resolved owner ids in this connector's terms. An EMPTY set
   * owns nothing, exactly as an empty `expectedOwnerIds` does in a
   * `FilterRule`: a missing policy input fails closed rather than reading as
   * PASS.
   */
  ownerIds: readonly string[];
  /**
   * The agent's own outbound request. Only its HEADERS travel with the probe —
   * the method, target and body are the proof's. That keeps the probe
   * indistinguishable, upstream, from a request the agent could have written
   * itself, trace context included.
   */
  req: IncomingShape;
  ctx: RequestContext;
  claims: MissionClaims;
}

/**
 * True when the probe's owner resolves into the mission's set. Reuses `isOwned`
 * so there is ONE place in this proxy where an object is proven ours.
 *
 * `exact` matching, with no way for a connector to ask for anything else: a
 * proof is about an identifier a vendor returned, and widening the set of
 * strings that count as a mission identifier is how a filter starts keeping
 * foreign objects. A vendor with two spellings of one id must be normalized by
 * its connector before the ids reach here.
 */
function ownedParent(parsed: unknown, call: ParentProofCall): boolean {
  return isOwned(parsed, {
    path: [],
    type: "parent",
    ownerPath: call.proof.ownerPath,
    expectedOwnerIds: call.ownerIds,
    ownerMatch: "exact",
    injected: [],
    nullable: false,
  });
}

/**
 * Proves the parent, or does not. There is no third answer and no reason
 * attached to `false` — a caller that could tell WHY would be able to answer
 * differently for a parent that exists than for one that does not.
 */
export async function proveParent(
  deps: ParentProofDeps,
  call: ParentProofCall,
): Promise<boolean> {
  const { proof, claims } = call;
  // Already proven for THIS mission: no extra call, no extra event, no extra
  // vendor budget spent.
  if (deps.proofs.isProven(claims.jti, proof.key)) return true;

  const verdict = deps.decide(proof.probe);
  if (verdict.decision === "deny") return false;
  if (!claims.allow.includes(verdict.action)) return false;

  // Re-resolved from the probe's own target, exactly as the pipeline does after
  // NARROW: a probe shrinks or redirects a read inside the connector's origin,
  // it never moves it to another one.
  const target = upstreamTarget(deps, proof.probe.path);
  if (target === undefined) return false;

  const probe: IncomingShape = {
    ...call.req,
    method: proof.probe.method,
    path: proof.probe.path,
    body: proof.probe.body,
  };
  // No filter task: this body is read here and dropped. It never reaches the
  // agent, so there is nothing in it to repair — only one field to look at.
  const answer = await forward(
    deps,
    target,
    probe,
    verdict,
    call.ctx,
    undefined,
    claims,
  );
  if (answer.status !== 200) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof answer.body === "string"
        ? answer.body
        : new TextDecoder().decode(answer.body),
    );
  } catch {
    return false;
  }
  if (!ownedParent(parsed, call)) return false;

  deps.proofs.record(claims.jti, proof.key);
  return true;
}

/** What the pipeline hands this stage, once it has an outbound request. */
export interface ParentProofStage {
  narrowed: NarrowResult;
  /** The narrowed outbound request: its headers travel with the probe. */
  req: IncomingShape;
  verdict: CatalogDecision;
  ctx: RequestContext;
  claims: MissionClaims;
}

/**
 * The stage as the pipeline calls it. `undefined` means the child may proceed;
 * anything else is the refusal it must answer with — built by `scopeDenial`, so
 * a parent that was never proven and a target NARROW refused outright are the
 * same bytes, and no future edit can make them drift apart.
 *
 * A connector that attached no requirement passes through untouched, without a
 * call, an event, or a branch anywhere else in the pipeline.
 */
export async function parentProofStage(
  deps: ParentProofDeps,
  stage: ParentProofStage,
): Promise<ReturnType<typeof scopeDenial> | undefined> {
  const proof = stage.narrowed.parentProof;
  if (proof === undefined) return undefined;
  const proven = await proveParent(deps, {
    proof,
    ownerIds: stage.narrowed.missionOwnerIds ?? [],
    req: stage.req,
    ctx: stage.ctx,
    claims: stage.claims,
  });
  if (proven) return undefined;
  emitEvent(
    deps,
    stage.ctx,
    claimsDenial(stage.verdict, PARENT_PROOF_REASON),
    PARENT_PROOF_REASON,
  );
  return scopeDenial(stage.narrowed, PARENT_PROOF_REASON);
}
