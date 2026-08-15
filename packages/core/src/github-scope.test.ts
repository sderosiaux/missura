import { describe, expect, it } from "vitest";
import { parseGithubRepoScope, pathPrefixSegments } from "./github-scope";

describe("parseGithubRepoScope — a bare repo still means the whole repository", () => {
  it("parses owner/name with no path prefix at all", () => {
    expect(parseGithubRepoScope("acme-corp/product")).toEqual({
      repo: "acme-corp/product",
    });
  });

  it("keeps the operator's casing", () => {
    expect(parseGithubRepoScope("ACME-Corp/Product").repo).toBe(
      "ACME-Corp/Product",
    );
  });

  it("rejects a spelling that is not owner/name", () => {
    for (const bad of ["product", "a/b/c", "", "/product", "acme/"]) {
      expect(() => parseGithubRepoScope(bad)).toThrow(/invalid repo/i);
    }
  });

  it("rejects an owner or name outside GitHub's own charset", () => {
    expect(() => parseGithubRepoScope("acme corp/product")).toThrow(
      /invalid repo/i,
    );
  });
});

describe("parseGithubRepoScope — `owner/name:path/prefix`", () => {
  it("splits on the first colon: `:` is not in GitHub's owner/repo charset", () => {
    expect(
      parseGithubRepoScope("acme-corp/transcripts:granola-transcripts/abcam"),
    ).toEqual({
      repo: "acme-corp/transcripts",
      pathPrefix: "granola-transcripts/abcam",
    });
  });

  it("leaves a later colon inside the path prefix", () => {
    expect(parseGithubRepoScope("a/b:dir:one/file").pathPrefix).toBe(
      "dir:one/file",
    );
  });

  it("accepts a single-segment prefix", () => {
    expect(parseGithubRepoScope("a/b:granola-transcripts").pathPrefix).toBe(
      "granola-transcripts",
    );
  });

  it("keeps the prefix's casing — git paths are case-sensitive", () => {
    expect(parseGithubRepoScope("a/b:Granola/Abcam").pathPrefix).toBe(
      "Granola/Abcam",
    );
  });

  it("rejects an empty prefix rather than reading `:` as the whole repo", () => {
    expect(() => parseGithubRepoScope("a/b:")).toThrow(/path prefix/i);
  });
});

describe("parseGithubRepoScope — the one sugar, and no glob dialect", () => {
  it("accepts a trailing `/**` and normalizes it away", () => {
    expect(parseGithubRepoScope("a/b:granola/abcam/**")).toEqual({
      repo: "a/b",
      pathPrefix: "granola/abcam",
    });
  });

  it("accepts a trailing slash and normalizes it away", () => {
    expect(parseGithubRepoScope("a/b:granola/abcam/").pathPrefix).toBe(
      "granola/abcam",
    );
  });

  it("rejects `/*`, which reads as one level and is not what a prefix means", () => {
    expect(() => parseGithubRepoScope("a/b:granola/*")).toThrow(/glob/i);
  });

  it("rejects every other glob metacharacter", () => {
    for (const bad of ["a/b:g?/x", "a/b:g[1]/x", "a/b:g{1}/x", "a/b:g*x/y"]) {
      expect(() => parseGithubRepoScope(bad)).toThrow(/glob/i);
    }
  });
});

describe("parseGithubRepoScope — a prefix that could not bound anything", () => {
  it("rejects a dot segment", () => {
    expect(() => parseGithubRepoScope("a/b:granola/./abcam")).toThrow(
      /path prefix/i,
    );
  });

  it("rejects a traversal segment", () => {
    expect(() => parseGithubRepoScope("a/b:granola/../secrets")).toThrow(
      /path prefix/i,
    );
  });

  it("rejects an empty inner segment", () => {
    expect(() => parseGithubRepoScope("a/b:granola//abcam")).toThrow(
      /path prefix/i,
    );
  });

  it("rejects a leading slash", () => {
    expect(() => parseGithubRepoScope("a/b:/granola")).toThrow(/path prefix/i);
  });

  it("rejects a backslash, which the connector reads as a separator", () => {
    expect(() => parseGithubRepoScope("a/b:granola\\abcam")).toThrow(
      /path prefix/i,
    );
  });
});

describe("pathPrefixSegments", () => {
  it("splits a normalized prefix into the segments a request is compared to", () => {
    expect(pathPrefixSegments("granola-transcripts/abcam")).toEqual([
      "granola-transcripts",
      "abcam",
    ]);
  });
});
