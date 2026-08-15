import type { GithubRepoScope } from "@missura/core";
import { describe, expect, it } from "vitest";
import { narrowGithub } from "./narrow";

/**
 * ONE shared repository, ninety-six customers, one directory each. Scoping a
 * `customer:abcam` mission to the repository would hand the agent all of them —
 * the exact leak the product exists to prevent. So the mission's entry names a
 * PATH, and this file pins what that entry does and does not buy.
 */
const SHARED = "acme-corp/customer-data";

function scope(...repos: GithubRepoScope[]): { githubRepos: GithubRepoScope[] } {
  return { githubRepos: repos };
}

const PREFIXED = scope({
  repo: SHARED,
  pathPrefix: "granola-transcripts/abcam",
});

describe("a prefixed entry buys nothing a path prefix cannot bound", () => {
  /**
   * An issue, a pull request and the repository object name no directory. There
   * is no field on any of them that says which customer they belong to, so a
   * path prefix cannot bound them and they fail closed — every one of them, by
   * name, rather than by whichever ones somebody remembered to list.
   */
  it.each([
    ["the repository object", `/repos/${SHARED}`],
    ["the issue list", `/repos/${SHARED}/issues`],
    ["one issue", `/repos/${SHARED}/issues/42`],
    ["an issue's comments", `/repos/${SHARED}/issues/42/comments`],
    ["the pull request list", `/repos/${SHARED}/pulls`],
    ["one pull request", `/repos/${SHARED}/pulls/7`],
  ])("denies %s, github404-shaped", (_label, path) => {
    const result = narrowGithub(path, PREFIXED);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
    expect(result.denialCode).toBe("missura_out_of_path_scope");
  });

  it("denies /search/issues when every entry is path-scoped", () => {
    const result = narrowGithub("/search/issues?q=bug", PREFIXED);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
    expect(result.denialCode).toBe("missura_out_of_path_scope");
  });

  /**
   * A prefixed entry is dropped from the search rather than taking the search
   * down with it: the mission's OTHER, whole-repository entries are still
   * searchable, and the prefixed repository is not forced into the query — that
   * would widen the mission to all of it.
   */
  it("searches the mission's bare repositories only, never the path-scoped one", () => {
    const result = narrowGithub(
      "/search/issues?q=bug",
      scope({ repo: "acme-corp/product" }, {
        repo: SHARED,
        pathPrefix: "granola-transcripts/abcam",
      }),
    );
    expect(result.decision).toBe("allow");
    const q = new URL(result.path ?? "", "https://vendor.invalid").searchParams.get("q") ?? "";
    expect(q).toContain("repo:acme-corp/product");
    expect(q).not.toContain(SHARED);
    const owners = result.filterPlan?.rules[0]?.expectedOwnerIds ?? [];
    expect(owners).toEqual(["https://api.github.com/repos/acme-corp/product"]);
  });
});

/**
 * THE DIRECTORY-LISTING RULE, pinned by the property it protects.
 *
 * `GET /contents/granola-transcripts` answers with every entry of that
 * directory — which is one directory per customer, so the answer IS the
 * customer list. There is no way to serve that listing and still say the
 * mission covers one customer, and there is no field on a listing entry that
 * could prove otherwise; filtering it down to the single in-prefix entry would
 * be a different answer from the vendor's, not a narrower one.
 *
 * So: a listing whose own path is a STRICT ANCESTOR of the mission's prefix
 * denies. At or below the prefix, it is served — a listing there enumerates
 * only paths the mission already covers.
 */
describe("a listing above the mission's path enumerates its siblings, so it denies", () => {
  it.each([
    ["the repository root", ""],
    ["the export directory holding all customers", "/granola-transcripts"],
  ])("denies the strict-ancestor listing at %s", (_label, target) => {
    const result = narrowGithub(`/repos/${SHARED}/contents${target}`, PREFIXED);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
    expect(result.denialCode).toBe("missura_out_of_path_scope");
  });

  it.each([
    ["the prefix itself", "/granola-transcripts/abcam"],
    ["a directory below it", "/granola-transcripts/abcam/attachments"],
  ])("serves the listing at or below the prefix: %s", (_label, target) => {
    expect(
      narrowGithub(`/repos/${SHARED}/contents${target}`, PREFIXED).decision,
    ).toBe("allow");
  });

  /**
   * An ancestor is decided from the mission's prefix alone, so the answer is
   * the same for a directory that exists and one that never did — it is not an
   * existence oracle, and the distinct reason is what lets an agent correct
   * itself instead of probing.
   */
  it("says WHICH refusal it is, without naming anything it refused", () => {
    const ancestor = narrowGithub(
      `/repos/${SHARED}/contents/granola-transcripts`,
      PREFIXED,
    );
    const outside = narrowGithub(
      `/repos/${SHARED}/contents/google-drive-customers-se`,
      PREFIXED,
    );
    expect(ancestor.reason).not.toBe(outside.reason);
    expect(ancestor.reason).toContain("above");
    for (const result of [ancestor, outside]) {
      expect(JSON.stringify(result)).not.toContain("granola");
      expect(JSON.stringify(result)).not.toContain("google-drive");
    }
  });
});

describe("a bare entry is untouched — no regression for existing missions", () => {
  const BARE = scope({ repo: SHARED });

  it.each([
    `/repos/${SHARED}`,
    `/repos/${SHARED}/issues`,
    `/repos/${SHARED}/contents`,
    `/repos/${SHARED}/contents/granola-transcripts/zoetis/call.md`,
  ])("allows %s", (path) => {
    expect(narrowGithub(path, BARE).decision).toBe("allow");
  });

  /**
   * An operator who wrote both granted the wider of the two. Reading it the
   * other way would mean a mission SHRINKS when a path entry is added beside a
   * repository entry, which is not what either line says.
   */
  it("lets a bare entry win over a prefixed one on the same repository", () => {
    const both = scope({ repo: SHARED }, {
      repo: SHARED,
      pathPrefix: "granola-transcripts/abcam",
    });
    expect(narrowGithub(`/repos/${SHARED}/issues`, both).decision).toBe("allow");
  });
});
