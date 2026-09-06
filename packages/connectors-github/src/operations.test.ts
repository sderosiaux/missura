import type { ResolvedScope } from "@missura/core";
import { describe, expect, it } from "vitest";
import { decideGithub } from "./catalog";
import { narrowGithub } from "./narrow";
import { GITHUB_OPERATIONS, issuesForEntity } from "./operations";

/**
 * Same proof as the other connectors: every step is a raw request the
 * connector's own catalog and NARROW allow as they are, under the same scope.
 */

const SCOPE: ResolvedScope = {
  githubRepos: [{ repo: "acme-corp/product" }, { repo: "acme-corp/infra" }],
};

describe("github.issues.for_entity", () => {
  it("is the one GitHub read, and says what it needs", () => {
    expect(GITHUB_OPERATIONS.map((op) => op.name)).toEqual([
      "github.issues.for_entity",
    ]);
    expect(issuesForEntity).toMatchObject({
      connector: "github",
      effect: "read",
      needs: "github.repo",
    });
  });

  it("plans one open-issues list per repository in the scope", () => {
    expect(issuesForEntity.plan(SCOPE, {})).toEqual([
      { method: "GET", path: "/repos/acme-corp/product/issues?state=open", body: "" },
      { method: "GET", path: "/repos/acme-corp/infra/issues?state=open", body: "" },
    ]);
  });

  it("plans nothing for a scope with no repository", () => {
    expect(issuesForEntity.plan({ githubRepos: [] }, {})).toEqual([]);
  });

  it("plans steps the connector's own catalog and NARROW allow as they are", () => {
    for (const step of issuesForEntity.plan(SCOPE, {})) {
      const verdict = decideGithub(step.method, step.path);
      expect(verdict.decision).toBe("allow");
      expect(verdict.operation).toBe("repos.issues.list");
      const narrowed = narrowGithub(step.path, { githubRepos: SCOPE.githubRepos });
      expect(narrowed.decision).toBe("allow");
      expect(narrowed.path).toBe(step.path);
    }
  });

  /**
   * A path-scoped repository serves `contents` and nothing else. The plan does
   * NOT skip it — that would be a copy of NARROW's rule — it plans the step
   * and NARROW refuses it, as it would the raw request.
   */
  it("leaves a path-scoped repository to NARROW, which refuses the step", () => {
    const scoped: ResolvedScope = {
      githubRepos: [{ repo: "acme-corp/transcripts", pathPrefix: "acme" }],
    };
    const [step] = issuesForEntity.plan(scoped, {});
    if (step === undefined) throw new Error("no step planned");
    expect(narrowGithub(step.path, { githubRepos: scoped.githubRepos }).decision).toBe(
      "deny",
    );
  });
});
