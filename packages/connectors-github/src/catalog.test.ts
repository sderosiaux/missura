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
