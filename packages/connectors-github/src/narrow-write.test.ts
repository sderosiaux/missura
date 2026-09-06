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

  /**
   * The destroy (M10) is the same decision on the same path: a comment id
   * says nothing about a repository, so the repository in the path is the one
   * check, and a foreign one wears the read's not-found.
   */
  it("decides DELETE of a comment by its repository, like the reads and the append", () => {
    const DELETE = { method: "DELETE", via: { operation: "github.issue.comment.delete" } };
    const ours = narrowGithub("/repos/acme-corp/product/issues/comments/9001", SCOPE, DELETE);
    expect(ours.decision).toBe("allow");
    expect(ours.path).toBe("/repos/acme-corp/product/issues/comments/9001");
    const foreign = narrowGithub("/repos/globex/secret/issues/comments/9001", SCOPE, DELETE);
    expect(foreign).toEqual(narrowGithub("/repos/globex/secret/issues/7", SCOPE));
    expect(
      narrowGithub("/repos/acme-corp/product/issues/comments/9001", SCOPE, { method: "DELETE" })
        .decision,
    ).toBe("deny");
  });

  /**
   * L8: a comment id is GLOBAL on GitHub, and the path's repository says
   * nothing about where the comment lives. A `destroy` proves it before the
   * DELETE: fetch the comment through the same pipeline and check its own
   * `url` names the repository in the path — re-proven at execution, never
   * from the memo (`parent-proof.ts`). And the read of a comment by id, which
   * the probe needs cataloged, is filtered on the same field.
   */
  it("attaches a proof of the comment to the DELETE: its own url, in the path's repository", () => {
    const DELETE = { method: "DELETE", via: { operation: "github.issue.comment.delete" } };
    const ours = narrowGithub("/repos/acme-corp/product/issues/comments/9001", SCOPE, DELETE);
    expect(ours.decision).toBe("allow");
    expect(ours.parentProof).toEqual({
      key: "comment:acme-corp/product:9001",
      probe: { method: "GET", path: "/repos/acme-corp/product/issues/comments/9001", body: "" },
      ownerPath: ["url"],
      ownerMatch: "ascii-case-insensitive",
    });
    expect(ours.missionOwnerIds).toEqual([
      "https://api.github.com/repos/acme-corp/product/issues/comments/9001",
    ]);
    expect(ours.filterPlan).toBeUndefined();
  });

  it("proves a comment read by id on its own url, and refuses one outside the mission", () => {
    const read = narrowGithub("/repos/acme-corp/product/issues/comments/9001", SCOPE);
    expect(read.decision).toBe("allow");
    expect(read.denyShape).toBe("github404");
    expect(read.filterPlan).toEqual({
      rules: [
        {
          path: [],
          type: "issue-comment",
          ownerPath: ["url"],
          expectedOwnerIds: ["https://api.github.com/repos/acme-corp/product/issues/comments/9001"],
          ownerMatch: "ascii-case-insensitive",
          injected: [],
          nullable: false,
        },
      ],
      strip: [],
    });
    expect(narrowGithub("/repos/globex/secret/issues/comments/9001", SCOPE)).toEqual(
      narrowGithub("/repos/globex/secret/issues/7", SCOPE),
    );
  });

  it("refuses the POST with no operation behind it, whatever the repo", () => {
    const result = narrowGithub("/repos/acme-corp/product/issues/7/comments", SCOPE, {
      method: "POST",
    });
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});
