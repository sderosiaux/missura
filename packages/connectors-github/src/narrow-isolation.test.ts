import type { GithubRepoScope } from "@missura/core";
import { describe, expect, it } from "vitest";
import { narrowGithub, type GithubNarrowResult } from "./narrow";

/**
 * THE ISOLATION PROPERTY, written adversarially rather than mechanically.
 *
 * The mission covers ONE customer's directory inside a repository that holds
 * ninety-six of them. The property is not "the prefix check works" — it is that
 * NOTHING reaches a second customer's directory: not a direct path, not an
 * encoded traversal, not a parent listing, not search, and not any other
 * endpoint on that repository, because none of those carries a path a prefix
 * could bound.
 *
 * Every case below is a route to `zoetis`, written the way an agent that wanted
 * one would write it. A case that ALLOWS is a leak of a customer's call
 * transcripts to another customer's mission.
 */

const SHARED = "acme-corp/customer-data";
const MISSION: GithubRepoScope = {
  repo: SHARED,
  pathPrefix: "granola-transcripts/abcam",
};
const SCOPE = { githubRepos: [MISSION] };

/** Everything the mission must not reach, in the vendor's own decoded terms. */
const FOREIGN = ["zoetis", "google-drive-customers-se", "abcam-corp", "ABCAM"];

interface Hostile {
  name: string;
  path: string;
}

const HOSTILE: Hostile[] = [
  {
    name: "another customer's directory, spelled plainly",
    path: `/repos/${SHARED}/contents/granola-transcripts/zoetis`,
  },
  {
    name: "a file inside another customer's directory",
    path: `/repos/${SHARED}/contents/granola-transcripts/zoetis/2026-01-12.md`,
  },
  {
    name: "a traversal out of the prefix and back down",
    path: `/repos/${SHARED}/contents/granola-transcripts/abcam/../zoetis`,
  },
  {
    name: "the same traversal with an encoded separator (%2f)",
    path: `/repos/${SHARED}/contents/granola-transcripts/abcam/..%2fzoetis`,
  },
  {
    name: "a double-encoded traversal (%252f)",
    path: `/repos/${SHARED}/contents/granola-transcripts/abcam/..%252fzoetis`,
  },
  {
    name: "a backslash traversal (%5C), which some normalizers split on",
    path: `/repos/${SHARED}/contents/granola-transcripts/abcam/..%5Czoetis`,
  },
  {
    name: "an encoded separator building the foreign path in one segment",
    path: `/repos/${SHARED}/contents/granola-transcripts%2Fzoetis`,
  },
  {
    name: "the parent listing, which returns all ninety-six directory names",
    path: `/repos/${SHARED}/contents/granola-transcripts`,
  },
  {
    name: "the repository root listing, which returns the sibling trees too",
    path: `/repos/${SHARED}/contents`,
  },
  {
    name: "a sibling tree of the same customers under another export",
    path: `/repos/${SHARED}/contents/google-drive-customers-se/zoetis`,
  },
  {
    name: "a prefix that is only a string prefix, not a path one",
    path: `/repos/${SHARED}/contents/granola-transcripts/abcam-corp/secret.md`,
  },
  {
    name: "the prefix case-folded — git paths are case-sensitive",
    path: `/repos/${SHARED}/contents/granola-transcripts/ABCAM/secret.md`,
  },
  {
    name: "issues, which name no directory and prove no customer",
    path: `/repos/${SHARED}/issues?state=all&per_page=100`,
  },
  {
    name: "one issue, whose body may quote any customer's call",
    path: `/repos/${SHARED}/issues/1`,
  },
  {
    name: "an issue's comments",
    path: `/repos/${SHARED}/issues/1/comments`,
  },
  {
    name: "pull requests, whose diffs touch every customer's directory",
    path: `/repos/${SHARED}/pulls?state=all`,
  },
  {
    name: "one pull request",
    path: `/repos/${SHARED}/pulls/3`,
  },
  {
    name: "the repository object itself",
    path: `/repos/${SHARED}`,
  },
  {
    name: "search, which cannot be bounded by a path",
    path: `/search/issues?q=${encodeURIComponent("zoetis in:body")}`,
  },
  {
    name: "search with the repository forced by the agent",
    path: `/search/issues?q=${encodeURIComponent(`repo:${SHARED} zoetis`)}`,
  },
  {
    name: "a repository-scoped route the catalog never admitted",
    path: `/repos/${SHARED}/collaborators`,
  },
];

/** Everything the refusal and the forwarded target could have carried out. */
function serialize(result: GithubNarrowResult): string {
  return JSON.stringify(result);
}

describe("narrowGithub — path isolation inside one shared repository", () => {
  it.each(HOSTILE)("denies: $name", ({ path }: Hostile) => {
    const result = narrowGithub(path, SCOPE);
    expect(result.decision).toBe("deny");
    // GitHub's own absence: a refusal reads the same as a path that never
    // existed, so no probe can tell a foreign customer from an empty one.
    expect(result.denyShape).toBe("github404");
    expect(result.path).toBeUndefined();
  });

  /**
   * A refusal is derived from the mission and from the request the agent wrote
   * itself. It may never quote a directory the mission does not cover — doing
   * so would confirm the name back to the agent that guessed it.
   */
  it.each(HOSTILE)("names no foreign directory in the refusal: $name", ({ path }: Hostile) => {
    const serialized = serialize(narrowGithub(path, SCOPE));
    for (const foreign of FOREIGN) {
      expect(serialized).not.toContain(foreign);
    }
  });

  /**
   * The count of the mission's own entries is a fact about the agent's grant,
   * so it rides along; the entries themselves never do.
   */
  it("carries the scope COUNT on a refusal and never the prefix", () => {
    const result = narrowGithub(`/repos/${SHARED}/contents`, SCOPE);
    expect(result.missionScopeSize).toBe(1);
    expect(serialize(result)).not.toContain("abcam");
  });
});

describe("narrowGithub — what the mission does reach", () => {
  it.each([
    ["its own directory", "granola-transcripts/abcam"],
    ["a file in it", "granola-transcripts/abcam/2026-01-12.md"],
    ["a directory below it", "granola-transcripts/abcam/attachments"],
    ["a file below that", "granola-transcripts/abcam/attachments/deck.pdf"],
  ])("allows %s", (_label, target) => {
    const result = narrowGithub(`/repos/${SHARED}/contents/${target}`, SCOPE);
    expect(result.decision).toBe("allow");
    expect(result.path).toBe(`/repos/${SHARED}/contents/${target}`);
  });

  /**
   * The decision is taken on the canonical, decoded path and that same path is
   * what travels — the property the repo half already had, now carrying the
   * prefix check with it. Deciding on one spelling and forwarding another is
   * how a decision about one directory becomes a credentialed read of another.
   */
  it("forwards the canonical spelling it decided on, not the agent's", () => {
    const result = narrowGithub(
      `/repos/${SHARED}/contents/granola-transcripts%2Fabcam%2Fcall.md`,
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(result.path).toBe(
      `/repos/${SHARED}/contents/granola-transcripts/abcam/call.md`,
    );
  });

  it("keeps the query string, so `?ref=` still selects a git ref", () => {
    const result = narrowGithub(
      `/repos/${SHARED}/contents/granola-transcripts/abcam?ref=main`,
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(result.path).toBe(
      `/repos/${SHARED}/contents/granola-transcripts/abcam?ref=main`,
    );
  });

  /** Two customers' exports of the same customer: both entries are the mission's. */
  it("honours every prefix a mission holds on one repository", () => {
    const scope = {
      githubRepos: [
        MISSION,
        { repo: SHARED, pathPrefix: "google-drive-customers-se/abcam" },
      ],
    };
    for (const target of [
      "granola-transcripts/abcam/call.md",
      "google-drive-customers-se/abcam/notes.md",
    ]) {
      expect(narrowGithub(`/repos/${SHARED}/contents/${target}`, scope).decision).toBe(
        "allow",
      );
    }
    expect(
      narrowGithub(
        `/repos/${SHARED}/contents/google-drive-customers-se/zoetis`,
        scope,
      ).decision,
    ).toBe("deny");
  });

  /** A prefix on one repository says nothing about another repository. */
  it("leaves a second, whole-repository entry alone", () => {
    const scope = { githubRepos: [MISSION, { repo: "acme-corp/product" }] };
    expect(narrowGithub("/repos/acme-corp/product/issues", scope).decision).toBe(
      "allow",
    );
    expect(narrowGithub(`/repos/${SHARED}/issues`, scope).decision).toBe("deny");
  });
});
