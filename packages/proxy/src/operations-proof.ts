import type { MissionClaims } from "@missura/core";
import type { Admission } from "./admit";
import type { RequestContext } from "./audit";
import { denialResponse } from "./deny";
import { parentProofStage } from "./parent-proof";
import type { PipelineDeps } from "./pipeline";
import type { IncomingShape, ResponseShape } from "./transport";

/**
 * The PARENT PROOF of one gated step, run by the executor at REQUEST time
 * (M2), before the step is written down for a human.
 *
 * `admit` costs no vendor call by design, and for a GitHub write that is the
 * whole proof: the repository is in the path. A Zendesk ticket names no
 * organization anywhere but on itself, so its proof is a read of the ticket
 * — the same probe the pipeline runs before serving its comments, through
 * the same stage, on the connector's own pipeline. Without it a foreign
 * ticket answers `202` and an approval exists for a target the mission never
 * held; the human is then asked to approve it, and an approval they grant is
 * burned at execution. The proof is a read the mission already holds, and
 * a foreign target is refused with the bytes a foreign read gets — the
 * connector's own not-found, with the mission's remediation.
 */
export async function proveStep(
  target: PipelineDeps,
  inner: IncomingShape,
  admitted: Admission,
  ctx: RequestContext,
  claims: MissionClaims,
): Promise<ResponseShape | undefined> {
  const { narrowed, verdict } = admitted;
  const unproven = await parentProofStage(target, {
    narrowed,
    // The narrowed request, as the pipeline would forward it: its headers
    // travel with the probe, so the probe is the agent's own read upstream.
    req: {
      ...inner,
      path: narrowed.path ?? inner.path,
      body: narrowed.body ?? inner.body,
    },
    verdict,
    ctx,
    claims,
  });
  if (unproven === undefined) return undefined;
  return denialResponse(target.provider, { ...unproven, claims, now: ctx.startedAt });
}
