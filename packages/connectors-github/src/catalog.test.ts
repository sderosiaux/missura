import { describe, expect, it } from "vitest";
import { decideGithub } from "./catalog";

describe("github rest catalog", () => {
  it("allows GET /repos/{owner}/{repo}", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.get");
    expect(d.action).toBe("read");
  });

  it("allows GET /repos/{owner}/{repo}/issues", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/issues");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.issues.list");
  });

  it("allows GET /repos/{owner}/{repo}/issues/{n}", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/issues/42");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.issues.get");
  });

  it("allows GET /repos/{owner}/{repo}/issues/{n}/comments", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/issues/42/comments");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.issues.comments.list");
  });

  /** The read the destroy proves itself against (L8): one comment, by id. */
  it("allows GET /repos/{owner}/{repo}/issues/comments/{id}", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/issues/comments/9001");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.issues.comments.get");
    expect(d.action).toBe("read");
  });

  it("allows GET /repos/{owner}/{repo}/pulls", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/pulls");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.pulls.list");
  });

  it("allows GET /repos/{owner}/{repo}/pulls/{n}", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/pulls/7");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.pulls.get");
  });

  it("allows GET /repos/{owner}/{repo}/contents/{path...}", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/contents/src/index.ts");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.contents.get");
  });

  it("allows GET /repos/{owner}/{repo}/contents at the root", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/contents");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.contents.get");
  });

  it("allows GET /search/issues", () => {
    const d = decideGithub("GET", "/search/issues?q=repo:octocat/hello-world");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("search.issues");
  });

  it("denies GET /user with a reason naming the path", () => {
    const d = decideGithub("GET", "/user");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("/user");
  });

  it("denies POST to an otherwise-allowlisted path, naming the method", () => {
    const d = decideGithub("POST", "/repos/octocat/hello-world/issues");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("POST");
  });

  it("denies zipball downloads", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/zipball/main");
    expect(d.decision).toBe("deny");
  });

  it("handles a trailing slash on an allowed path", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/issues/");
    expect(d.decision).toBe("allow");
    expect(d.operation).toBe("repos.issues.list");
  });

  it("handles a query string on an allowed path", () => {
    const d = decideGithub("GET", "/repos/octocat/hello-world/issues?state=open");
    expect(d.decision).toBe("allow");
  });

  it("denies an unlisted top-level path", () => {
    const d = decideGithub("GET", "/orgs/octocat/repos");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("not in the");
  });

  it("denies methods other than GET even when unrecognized", () => {
    const d = decideGithub("DELETE", "/repos/octocat/hello-world");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("DELETE");
  });
});

/**
 * THE WRITE ROUTE (M8) exists only for an inner call of an operation — the
 * `via` the executor sets in-process. Off the wire there is no `via`, so the
 * raw catalog stays what it was: GET only, and a POST is refused with the same
 * verdict it always got. Nothing an agent puts in a request can produce one.
 */
describe("github rest catalog — the write route, inner calls only", () => {
  const VIA = { operation: "github.issue.comment.create" };
  const COMMENTS = "/repos/octocat/hello-world/issues/42/comments";

  it("allows POST issue comments under an operation, as an append", () => {
    const d = decideGithub("POST", COMMENTS, VIA);
    expect(d).toEqual({
      decision: "allow",
      operation: "repos.issues.comments.create",
      action: "append",
      reason: "append request matching allowlisted route: repos.issues.comments.create",
    });
  });

  it("refuses the same POST with no operation behind it — the raw path never writes", () => {
    const raw = decideGithub("POST", COMMENTS);
    expect(raw.decision).toBe("deny");
    expect(raw.reason).toContain("POST");
    expect(raw).toEqual(decideGithub("POST", "/repos/octocat/hello-world/issues"));
  });

  /**
   * THE DESTROY ROUTE (M10): one comment, deleted, `action: destroy`. Which
   * operation stands behind the inner call is the pipeline's question — it
   * refuses a write whose effect is not the operation's — so the catalog
   * answers for any `via` and names the effect the route costs.
   */
  it("allows DELETE of an issue comment under an operation, as a destroy", () => {
    const d = decideGithub("DELETE", "/repos/octocat/hello-world/issues/comments/9001", {
      operation: "github.issue.comment.delete",
    });
    expect(d).toEqual({
      decision: "allow",
      operation: "repos.issues.comments.delete",
      action: "destroy",
      reason: "destroy request matching allowlisted route: repos.issues.comments.delete",
    });
    expect(decideGithub("DELETE", "/repos/octocat/hello-world/issues/comments/9001").decision).toBe(
      "deny",
    );
  });

  it("opens no other write under an operation: one route per write, one method each", () => {
    for (const [method, path] of [
      ["POST", "/repos/octocat/hello-world/issues"],
      ["POST", "/repos/octocat/hello-world/issues/42"],
      ["POST", "/repos/octocat/hello-world/pulls/7/comments"],
      ["PATCH", COMMENTS],
      ["DELETE", COMMENTS],
      ["DELETE", "/repos/octocat/hello-world/issues/42"],
      ["DELETE", "/repos/octocat/hello-world"],
      ["PUT", COMMENTS],
    ] as const) {
      expect(decideGithub(method, path, VIA).decision, `${method} ${path}`).toBe("deny");
    }
  });

  it("decides a GET under an operation exactly as it does off the wire", () => {
    const path = "/repos/octocat/hello-world/issues?state=open";
    expect(decideGithub("GET", path, VIA)).toEqual(decideGithub("GET", path));
    expect(decideGithub("GET", "/user", VIA)).toEqual(decideGithub("GET", "/user"));
  });
});
