import { describe, expect, it } from "vitest";
import { narrowGithub } from "./narrow";

const SCOPE = { githubRepos: ["acme-corp/product", "acme-corp/infra"] };

function q(path: string | undefined): string {
  return new URL(path ?? "", "https://vendor.invalid").searchParams.get("q") ?? "";
}

function search(query: string, scope = SCOPE): ReturnType<typeof narrowGithub> {
  return narrowGithub(`/search/issues?q=${encodeURIComponent(query)}`, scope);
}

/**
 * M2 refused every query carrying GitHub's boolean grammar, because appending
 * `repo:` qualifiers to `is:issue OR repo:globex/secret` produces a query that
 * no longer forces anything. The enforcement point has moved: the query runs
 * as written and the RESPONSE is filtered, so the grammar is legitimate again.
 */
describe("narrowGithub — /search/issues boolean syntax runs and is filtered", () => {
  it("allows `OR`, forces nothing, and files a filter plan instead", () => {
    const result = search("is:issue OR repo:globex/secret");

    expect(result.decision).toBe("allow");
    // Rewriting a grammar we do not parse is what M2 refused to do, and it is
    // still refused: the query travels as the agent wrote it.
    expect(q(result.path)).toBe("is:issue OR repo:globex/secret");
    expect(q(result.path)).not.toContain("repo:acme-corp");
    expect(result.filterPlan?.rules).toHaveLength(1);
  });

  it.each(["AND", "NOT", "or", "not"])(
    "allows the standalone operator %s",
    (op) => {
      expect(search(`bug ${op} crash`).decision).toBe("allow");
    },
  );

  it.each(["(bug or crash)", '"a phrase"'])(
    "allows grouping or quoting: %s",
    (term) => {
      const result = search(term);

      expect(result.decision).toBe("allow");
      expect(q(result.path)).toBe(term);
      expect(result.filterPlan?.rules).toHaveLength(1);
    },
  );

  it("keeps a term that merely contains the letters of an operator simple", () => {
    const result = search("order notes");

    expect(result.decision).toBe("allow");
    expect(q(result.path)).toContain("order notes");
    expect(q(result.path)).toContain("repo:acme-corp/product");
  });

  it("still forces the mission repos when the query is a plain conjunction", () => {
    const result = narrowGithub("/search/issues?q=login%20bug", SCOPE);

    expect(result.decision).toBe("allow");
    const value = q(result.path);
    expect(value).toContain("login");
    expect(value).toContain("repo:acme-corp/product");
    expect(value).toContain("repo:acme-corp/infra");
    // Cheaper than filtering, and never instead of it.
    expect(result.filterPlan?.rules).toHaveLength(1);
  });
});

/**
 * The contract-gap case: a mission holds SEVERAL repos, so a result is ours if
 * its repository is ANY of them. One rule per repo would drop what the other
 * keeps.
 */
describe("narrowGithub — the /search/issues filter plan", () => {
  it("guards every search item against every mission repo at once", () => {
    const rule = search("is:issue OR repo:globex/secret").filterPlan?.rules[0];

    expect(rule?.path).toEqual(["items", "*"]);
    // VERIFIED against the live API: a `/search/issues` item is an ISSUE and
    // carries `repository_url`; there is no `repository` object on it.
    expect(rule?.ownerPath).toEqual(["repository_url"]);
    expect(rule?.expectedOwnerIds).toEqual([
      "https://api.github.com/repos/acme-corp/product",
      "https://api.github.com/repos/acme-corp/infra",
    ]);
  });

  it("compares the repository URL ASCII-case-insensitively", () => {
    const rule = search("bug").filterPlan?.rules[0];

    expect(rule?.ownerMatch).toBe("ascii-case-insensitive");
  });

  it("adds nothing to the request, so it takes nothing back out", () => {
    const plan = search("bug").filterPlan;

    expect(plan?.rules[0]?.injected).toEqual([]);
    expect(plan?.strip).toEqual([]);
  });

  it("names GitHub's own not-found as the fail-closed body", () => {
    expect(search("bug").denyShape).toBe("github404");
  });

  it("denies rather than plan against a repo GitHub could not name", () => {
    const result = search("bug", { githubRepos: ["acme corp/product"] });

    expect(result.decision).toBe("deny");
    expect(result.denyShape).toBe("github404");
  });
});

describe("narrowGithub — /search/issues parameter keys", () => {
  it("sanitizes `Q` too — a simple query is never forwarded raw on its casing", () => {
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

  it("keeps the other parameters on a query it forwards verbatim", () => {
    const result = narrowGithub(
      `/search/issues?q=${encodeURIComponent('"login bug" OR crash')}&per_page=10`,
      SCOPE,
    );
    const url = new URL(result.path ?? "", "https://vendor.invalid");
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(url.searchParams.get("q")).toBe('"login bug" OR crash');
  });
});
