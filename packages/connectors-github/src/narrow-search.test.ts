import { describe, expect, it } from "vitest";
import { narrowGithub } from "./narrow";

const SCOPE = { githubRepos: ["acme-corp/product", "acme-corp/infra"] };

function q(path: string | undefined): string {
  return new URL(path ?? "", "https://vendor.invalid").searchParams.get("q") ?? "";
}

/**
 * Appending `repo:` qualifiers only forces the search through the mission's
 * repos while the query is a plain conjunction of terms. GitHub's search
 * grammar has boolean operators, parentheses and quoted phrases, and we do not
 * parse it — so any query still carrying one of those after the agent's own
 * qualifiers were stripped is refused instead of rewritten.
 */
describe("narrowGithub — /search/issues boolean syntax", () => {
  it("denies `OR`, which would make the forced repo qualifier optional", () => {
    const result = narrowGithub(
      `/search/issues?q=${encodeURIComponent("is:issue OR repo:globex/secret")}`,
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
    expect(result.reason).toContain("boolean");
  });

  it.each(["AND", "NOT", "or", "not"])("denies the standalone operator %s", (op) => {
    const result = narrowGithub(
      `/search/issues?q=${encodeURIComponent(`bug ${op} crash`)}`,
      SCOPE,
    );
    expect(result.decision).toBe("deny");
  });

  it.each(["(bug", "bug)", '"a phrase"'])(
    "denies grouping or quoting: %s",
    (term) => {
      const result = narrowGithub(
        `/search/issues?q=${encodeURIComponent(term)}`,
        SCOPE,
      );
      expect(result.decision).toBe("deny");
    },
  );

  it("keeps a term that merely contains the letters of an operator", () => {
    const result = narrowGithub(
      `/search/issues?q=${encodeURIComponent("order notes")}`,
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(q(result.path)).toContain("order notes");
  });

  it("still narrows a simple search", () => {
    const result = narrowGithub("/search/issues?q=login%20bug", SCOPE);
    expect(result.decision).toBe("allow");
    const value = q(result.path);
    expect(value).toContain("login");
    expect(value).toContain("bug");
    expect(value).toContain("repo:acme-corp/product");
    expect(value).toContain("repo:acme-corp/infra");
  });
});

describe("narrowGithub — /search/issues parameter keys", () => {
  it("sanitizes `Q` too — a query parameter is never forwarded raw on its casing", () => {
    const result = narrowGithub(
      `/search/issues?Q=${encodeURIComponent("repo:globex/secret")}`,
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(result.path).not.toContain("globex");
    expect(q(result.path)).toBe("repo:acme-corp/product repo:acme-corp/infra");
  });

  it("denies two spellings of the same query parameter", () => {
    const result = narrowGithub("/search/issues?q=bug&Q=crash", SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });

  it("keeps the other search parameters untouched", () => {
    const result = narrowGithub(
      "/search/issues?q=bug&sort=created&per_page=10",
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    const url = new URL(result.path ?? "", "https://vendor.invalid");
    expect(url.searchParams.get("sort")).toBe("created");
    expect(url.searchParams.get("per_page")).toBe("10");
  });
});
