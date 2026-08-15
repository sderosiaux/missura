import { describe, expect, it } from "vitest";
import { narrowGithub, type GithubNarrowResult } from "./narrow";

const SCOPE = { githubRepos: ["acme-corp/product", "acme-corp/infra"] };

describe("narrowGithub — /repos/{owner}/{repo}/... allowlist", () => {
  it("allows a path on a mission repo, unchanged", () => {
    const result = narrowGithub("/repos/acme-corp/product/issues/42", SCOPE);
    expect(result.decision).toBe("allow");
    expect(result.path).toBe("/repos/acme-corp/product/issues/42");
  });

  it("allows repo root path on a mission repo", () => {
    const result = narrowGithub("/repos/acme-corp/product", SCOPE);
    expect(result.decision).toBe("allow");
  });

  it("is case-insensitive on owner/repo", () => {
    const result = narrowGithub("/repos/Acme-Corp/PRODUCT/pulls", SCOPE);
    expect(result.decision).toBe("allow");
  });

  it("denies a path on a repo not in the mission, github404 shaped", () => {
    const result = narrowGithub("/repos/octokit/octokit.js/issues", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
    expect(result.reason).toContain("repo not in mission");
  });

  it("denies when repo case differs but is still not in scope", () => {
    const result = narrowGithub("/repos/OTHER/repo/issues", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});

describe("narrowGithub — /search/issues qualifier forcing", () => {
  it("appends repo qualifiers for every mission repo, keeps other terms", () => {
    const result = narrowGithub("/search/issues?q=is%3Aopen%20bug", SCOPE);
    expect(result.decision).toBe("allow");
    expect(result.path).toBeTypeOf("string");
    const url = new URL(result.path ?? "", "https://vendor.invalid");
    const q = url.searchParams.get("q") ?? "";
    expect(q).toContain("is:open");
    expect(q).toContain("bug");
    expect(q).toContain("repo:acme-corp/product");
    expect(q).toContain("repo:acme-corp/infra");
  });

  it("strips agent-supplied repo:/org:/user: qualifiers (case-insensitive)", () => {
    const result = narrowGithub(
      "/search/issues?q=" +
        encodeURIComponent(
          "repo:evil/repo REPO:other/thing org:evilorg USER:evilactor bug",
        ),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    const url = new URL(result.path ?? "", "https://vendor.invalid");
    const q = url.searchParams.get("q") ?? "";
    expect(q.toLowerCase()).not.toContain("evil");
    expect(q).toContain("bug");
    expect(q).toContain("repo:acme-corp/product");
    expect(q).toContain("repo:acme-corp/infra");
  });

  it("URL-encodes the rewritten q in the returned path", () => {
    const result = narrowGithub("/search/issues?q=hello%20world", SCOPE);
    expect(result.path).toBeTypeOf("string");
    expect(result.path).not.toContain(" ");
  });

  it("denies /search/issues when scope has no repos", () => {
    const result = narrowGithub("/search/issues?q=bug", { githubRepos: [] });
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});

describe("narrowGithub — empty scope denies every github path", () => {
  it("denies /repos/... when scope has no repos", () => {
    const result = narrowGithub("/repos/acme-corp/product", { githubRepos: [] });
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});

describe("narrowGithub — defense in depth for non-catalog shapes", () => {
  it("denies a path that is neither /repos/... nor /search/issues", () => {
    const result: GithubNarrowResult = narrowGithub("/user", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });

  it("denies /orgs/... too", () => {
    const result = narrowGithub("/orgs/acme-corp/repos", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});
