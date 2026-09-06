import { describe, expect, it } from "vitest";
import { narrowGithub } from "./narrow";
import { REPO_NOT_IN_MISSION } from "./narrow-result";

/**
 * NARROW on the one write (M8): the same repository check the reads get,
 * decided BEFORE anything leaves. A read can be let through and filtered on
 * the way back; a comment cannot be un-posted, so the request-side refusal is
 * the only check there is — and it must wear the same not-found as a read on a
 * foreign repository, or the write route becomes the existence oracle the
 * reads were built not to be.
 */

const SCOPE = { githubRepos: [{ repo: "acme-corp/product" }, { repo: "acme-corp/infra" }] };
const VIA = { operation: "github.issue.comment.create" };
const POST = { method: "POST", via: VIA };

describe("narrowGithub — POST issue comments", () => {
  it("allows the write on a mission repo, forwarding the path it decided on", () => {
    const result = narrowGithub("/repos/acme-corp/product/issues/7/comments", SCOPE, POST);
    expect(result.decision).toBe("allow");
    expect(result.path).toBe("/repos/acme-corp/product/issues/7/comments");
    // Nothing to filter on a write: the check already happened.
    expect(result.filterPlan).toBeUndefined();
  });

  it("refuses a foreign repo with the reads' own not-found, before the vendor", () => {
    const write = narrowGithub("/repos/globex/secret/issues/7/comments", SCOPE, POST);
    const read = narrowGithub("/repos/globex/secret/issues/7", SCOPE);
    expect(write).toEqual({
      decision: "deny",
      denyShape: "github404",
      reason: REPO_NOT_IN_MISSION,
      denialCode: "missura_out_of_mission_scope",
      missionScopeSize: 2,
    });
    expect(write).toEqual(read);
  });

  it("refuses the write on a repository the mission holds only by path", () => {
    const scoped = {
      githubRepos: [{ repo: "acme-corp/transcripts", pathPrefix: "acme" }],
    };
    const result = narrowGithub(
      "/repos/acme-corp/transcripts/issues/7/comments",
      scoped,
      POST,
    );
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
    expect(result.denialCode).toBe("missura_out_of_path_scope");
  });

  it("re-checks the canonical target with the request's own method and origin", () => {
    // Collapsed, this lands on `/repos/acme-corp/product/issues` — a route the
    // catalog serves for GET. The request is a POST: forwarded as decided it
    // would CREATE AN ISSUE, so the re-check must ask about the POST.
    const escaped = narrowGithub(
      "/repos/acme-corp/product/issues/7/comments/..%2f..",
      SCOPE,
      POST,
    );
    expect(escaped.decision).toBe("deny");
    expect(escaped.denyShape).toBe("github404");
    // And the same collapse under a GET stays what it always was: allowed.
    const read = narrowGithub("/repos/acme-corp/product/issues/7/comments/..%2f..", SCOPE);
    expect(read.decision).toBe("allow");
    expect(read.path).toBe("/repos/acme-corp/product/issues");
  });

  it("refuses the POST with no operation behind it, whatever the repo", () => {
    const result = narrowGithub("/repos/acme-corp/product/issues/7/comments", SCOPE, {
      method: "POST",
    });
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});
