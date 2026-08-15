import type { DenialCode, FilterPlan } from "@missura/core";

/**
 * Structurally identical to the proxy's `NarrowResult`/`denyShape` — declared
 * here because a connector never imports the proxy (see packages/proxy/src/narrow.ts
 * for the seam this mirrors).
 */
export interface GithubNarrowResult {
  decision: "allow" | "deny";
  /** Rewritten request target (forced `repo:` qualifiers, for instance). */
  path?: string;
  /**
   * `github404` answers with GitHub's own not-found shape: no enumeration. On
   * an ALLOW it names the shape a fail-closed FILTER must take, so a refusal
   * on the way back reads as the vendor's own "not found" too.
   */
  denyShape?: "github404";
  reason?: string;
  /** Which §4.8bis remediation the refusal deserves (see the proxy's `NarrowResult`). */
  denialCode?: DenialCode;
  /** How many repos the mission covers — the count, never the names. */
  missionScopeSize?: number;
  /**
   * What the proxy must do to the response: which objects to prove ours, which
   * fields to take back. This is how a query we let run is made safe.
   */
  filterPlan?: FilterPlan;
}

export const REPO_NOT_IN_MISSION = "repo not in mission";
export const NOT_IN_CATALOG_SCOPE = "path not narrowable under a mission scope";
export const UNDECODABLE_PATH = "path is not decodable";

/**
 * Every refusal is github404-shaped, and every one of them says WHICH kind of
 * refusal it is — "this repo is not yours" and "no mission reaches this route"
 * need different advice, and neither is derived from the target: the first
 * counts the mission's repos, the second describes missura's own catalog.
 */
export function deny(
  reason: string,
  code: DenialCode = "missura_out_of_mission_scope",
): GithubNarrowResult {
  return {
    decision: "deny",
    denyShape: "github404",
    reason,
    denialCode: code,
  };
}
