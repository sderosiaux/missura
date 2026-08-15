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

/**
 * api.github.com decodes `%2F` as a path separator: a live
 * `GET /repos/octokit/octokit.js/contents/src%2Findex.ts` answers 200 with
 * `"path": "src/index.ts"`. `URL` does not — it normalizes `..` and `%2e%2e`
 * but leaves `..%2f` untouched — so a decision taken on the raw segments and a
 * vendor acting on the decoded ones can disagree about which repo is addressed.
 *
 * The decision is therefore taken on the fully decoded, dot-collapsed view of
 * the path, while the path forwarded upstream stays the client's original:
 * `src%2Findex.ts` keeps meaning exactly what GitHub says it means.
 */
describe("narrowGithub — encoded path separators", () => {
  it("denies an encoded traversal out of a mission repo", () => {
    const result = narrowGithub(
      "/repos/acme-corp/product/..%2f..%2fglobex/secret",
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
    expect(result.reason).toContain("repo not in mission");
  });

  it("denies an encoded traversal under a cataloged contents path", () => {
    const result = narrowGithub(
      "/repos/acme-corp/product/contents/..%2F..%2F..%2Fglobex/secret",
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });

  it("denies a backslash-encoded traversal (%5C, either case)", () => {
    for (const path of [
      "/repos/acme-corp/product/..%5c..%5cglobex/secret",
      "/repos/acme-corp/product/..%5C..%5Cglobex/secret",
    ]) {
      const result = narrowGithub(path, SCOPE);
      expect(result.decision).toBe("deny");
      expect(result.denyShape).toBe("github404");
    }
  });

  it("denies a double-encoded traversal (%252f)", () => {
    const result = narrowGithub(
      "/repos/acme-corp/product/..%252f..%252fglobex/secret",
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });

  it("keeps a legitimate encoded contents path working, forwarded as the path it was decided on", () => {
    // GitHub serves this exact spelling — a live
    // `GET /repos/{o}/{r}/contents/src%2Findex.ts` answers 200 with
    // `"path": "src/index.ts"` — so refusing every `%2F` would break a request
    // the vendor considers ordinary. It is forwarded canonicalized rather than
    // verbatim: `%2F` is a separator to GitHub, so the two spellings resolve to
    // the same file, and forwarding the spelling we did NOT decide on is what
    // let a decision about one repo travel as a request for another.
    const result = narrowGithub(
      "/repos/acme-corp/product/contents/src%2Findex.ts",
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(result.path).toBe("/repos/acme-corp/product/contents/src/index.ts");
  });

  it("keeps the unencoded spelling of the same path working", () => {
    const result = narrowGithub(
      "/repos/acme-corp/product/contents/src/index.ts",
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(result.path).toBe("/repos/acme-corp/product/contents/src/index.ts");
  });

  it("denies a path whose percent-encoding is malformed", () => {
    const result = narrowGithub("/repos/acme-corp/product/%zz", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });

  it("resolves an encoded owner/repo against the mission scope and forwards it decoded", () => {
    const result = narrowGithub("/repos/acme%2Dcorp/product/issues", SCOPE);
    expect(result.decision).toBe("allow");
    expect(result.path).toBe("/repos/acme-corp/product/issues");
  });
});
