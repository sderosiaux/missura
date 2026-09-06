import { OperationParameterError, type ResolvedScope } from "@missura/core";
import { describe, expect, it } from "vitest";
import { decideGithub } from "./catalog";
import { narrowGithub } from "./narrow";
import {
  GITHUB_OPERATIONS,
  issueCommentCreate,
  issueCommentDelete,
  issuesForEntity,
} from "./operations";

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
      "github.issue.comment.create",
      "github.issue.comment.delete",
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

/**
 * THE FIRST WRITE (M8). The plan builds ONE step from the agent's own
 * parameters and decides nothing: whether `repo` is the mission's is NARROW's
 * call, made on the step before anything leaves — the same call, in the same
 * not-found shape, a foreign read gets. A plan that looked the repo up itself
 * would be the second copy of the scope rule M7 forbade.
 */
describe("github.issue.comment.create", () => {
  const VIA = { operation: "github.issue.comment.create" };
  const PARAMS = { repo: "acme-corp/product", issue: 7, body: "Tracked — thanks." };

  it("is an append that needs a repository in the mission", () => {
    expect(issueCommentCreate).toMatchObject({
      name: "github.issue.comment.create",
      connector: "github",
      effect: "append",
      needs: "github.repo",
    });
  });

  it("plans exactly one POST to the issue's comments, carrying the body as GitHub takes it", () => {
    expect(issueCommentCreate.plan(SCOPE, PARAMS)).toEqual([
      {
        method: "POST",
        path: "/repos/acme-corp/product/issues/7/comments",
        body: '{"body":"Tracked — thanks."}',
      },
    ]);
  });

  it("plans a step the catalog and NARROW allow AS AN INNER CALL, and refuse off the wire", () => {
    const [step] = issueCommentCreate.plan(SCOPE, PARAMS);
    if (step === undefined) throw new Error("no step planned");
    const inner = decideGithub(step.method, step.path, VIA);
    expect(inner).toMatchObject({
      decision: "allow",
      operation: "repos.issues.comments.create",
      action: "append",
    });
    const narrowed = narrowGithub(step.path, SCOPE, { method: step.method, via: VIA });
    expect(narrowed.decision).toBe("allow");
    expect(narrowed.path).toBe(step.path);
    expect(decideGithub(step.method, step.path).decision).toBe("deny");
  });

  it("plans the step for a foreign repo too, and NARROW refuses it not-found shaped", () => {
    const [step] = issueCommentCreate.plan(SCOPE, { ...PARAMS, repo: "globex/secret" });
    if (step === undefined) throw new Error("no step planned");
    expect(step.path).toBe("/repos/globex/secret/issues/7/comments");
    const narrowed = narrowGithub(step.path, SCOPE, { method: step.method, via: VIA });
    expect(narrowed).toMatchObject({
      decision: "deny",
      denyShape: "github404",
      denialCode: "missura_out_of_mission_scope",
    });
  });

  it("refuses a parameter it cannot build a vendor request from, naming the parameter", () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ ...PARAMS, repo: "acme-corp" }, "repo"],
      [{ ...PARAMS, repo: "acme-corp/product/../globex" }, "repo"],
      [{ ...PARAMS, repo: 7 }, "repo"],
      [{ issue: 7, body: "x" }, "repo"],
      [{ ...PARAMS, issue: "7" }, "issue"],
      [{ ...PARAMS, issue: 0 }, "issue"],
      [{ ...PARAMS, issue: 7.5 }, "issue"],
      [{ ...PARAMS, body: "" }, "body"],
      [{ ...PARAMS, body: "   " }, "body"],
      [{ ...PARAMS, body: ["x"] }, "body"],
    ];
    for (const [params, parameter] of bad) {
      let thrown: unknown;
      try {
        issueCommentCreate.plan(SCOPE, params);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(OperationParameterError);
      expect((thrown as OperationParameterError).parameter).toBe(parameter);
      // The reason names the parameter and its shape — never the value.
      expect((thrown as Error).message).not.toContain("globex");
    }
  });
});

/**
 * THE DESTROY (M10): one comment, gone for good, `effect: "destroy"`. The
 * plan is the same shape as the append's — the agent's own parameters,
 * checked for shape, into a path that cannot spell another route — and
 * decides nothing. That it waits on a human is the executor's rule, read off
 * the effect; nothing here knows about approvals.
 */
describe("github.issue.comment.delete", () => {
  const VIA = { operation: "github.issue.comment.delete" };
  const PARAMS = { repo: "acme-corp/product", comment: 9001 };

  it("is a destroy that needs a repository in the mission", () => {
    expect(issueCommentDelete).toMatchObject({
      name: "github.issue.comment.delete",
      connector: "github",
      effect: "destroy",
      needs: "github.repo",
    });
  });

  it("plans exactly one DELETE of the comment, with no body", () => {
    expect(issueCommentDelete.plan(SCOPE, PARAMS)).toEqual([
      { method: "DELETE", path: "/repos/acme-corp/product/issues/comments/9001", body: "" },
    ]);
  });

  it("plans a step the catalog and NARROW allow AS AN INNER CALL, and refuse off the wire", () => {
    const [step] = issueCommentDelete.plan(SCOPE, PARAMS);
    if (step === undefined) throw new Error("no step planned");
    expect(decideGithub(step.method, step.path, VIA)).toMatchObject({
      decision: "allow",
      operation: "repos.issues.comments.delete",
      action: "destroy",
    });
    const narrowed = narrowGithub(step.path, SCOPE, { method: step.method, via: VIA });
    expect(narrowed.decision).toBe("allow");
    expect(narrowed.path).toBe(step.path);
    expect(decideGithub(step.method, step.path).decision).toBe("deny");
  });

  it("plans the step for a foreign repo too, and NARROW refuses it not-found shaped", () => {
    const [step] = issueCommentDelete.plan(SCOPE, { ...PARAMS, repo: "globex/secret" });
    if (step === undefined) throw new Error("no step planned");
    expect(narrowGithub(step.path, SCOPE, { method: step.method, via: VIA })).toMatchObject({
      decision: "deny",
      denyShape: "github404",
      denialCode: "missura_out_of_mission_scope",
    });
  });

  it("refuses a parameter it cannot build a vendor request from, naming the parameter", () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ ...PARAMS, repo: "acme-corp" }, "repo"],
      [{ comment: 9001 }, "repo"],
      [{ ...PARAMS, comment: "9001" }, "comment"],
      [{ ...PARAMS, comment: 0 }, "comment"],
      [{ ...PARAMS, comment: 9001.5 }, "comment"],
      [{ repo: "acme-corp/product" }, "comment"],
    ];
    for (const [params, parameter] of bad) {
      let thrown: unknown;
      try {
        issueCommentDelete.plan(SCOPE, params);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(OperationParameterError);
      expect((thrown as OperationParameterError).parameter).toBe(parameter);
    }
  });
});
