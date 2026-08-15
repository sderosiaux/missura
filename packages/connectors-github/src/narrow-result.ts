/**
 * Structurally identical to the proxy's `NarrowResult`/`denyShape` — declared
 * here because a connector never imports the proxy (see packages/proxy/src/narrow.ts
 * for the seam this mirrors).
 */
export interface GithubNarrowResult {
  decision: "allow" | "deny";
  /** Rewritten request target (forced `repo:` qualifiers, for instance). */
  path?: string;
  /** `github404` answers with GitHub's own not-found shape: no enumeration. */
  denyShape?: "github404";
  reason?: string;
}

export const REPO_NOT_IN_MISSION = "repo not in mission";
export const NOT_IN_CATALOG_SCOPE = "path not narrowable under a mission scope";
export const UNDECODABLE_PATH = "path is not decodable";

export function deny(reason: string): GithubNarrowResult {
  return { decision: "deny", denyShape: "github404", reason };
}
