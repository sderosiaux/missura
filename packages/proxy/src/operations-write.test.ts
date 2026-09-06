import type { Operation, OperationStep } from "@missura/core";
import { describe, expect, it } from "vitest";
import { INTROSPECTION_PATH } from "./introspect";
import {
  COMMENT_PARAMS,
  GITHUB_COMMENT,
  GRANTED,
  post,
  result,
  writeRig,
} from "./operations.fixtures";
import { handle } from "./pipeline";
import {
  bodyText,
  CLAIMS,
  graphqlDenial,
  request,
  restDenial,
} from "./pipeline.fixtures";

/**
 * THE M8 PROPERTY: writes happen only through operations, and a write is
 * proven before it happens. Reads are "let through, filter the answer"; a
 * comment cannot be un-posted, so the scope check on the inner call is the
 * only check there is, it runs BEFORE the vendor is reached, and a foreign
 * repository gets the not-found a foreign read gets — zero vendor calls.
 *
 * And the other half: the raw path never writes. The write route exists only
 * for a request the executor built in-process; an agent's own POST, through
 * the same pipeline with the same granted token, is refused at the catalog.
 */

const OP = GITHUB_COMMENT.name;
const COMMENTS = "/repos/acme-corp/product/issues/7/comments";

describe("the first write — github.issue.comment.create through the pipeline", () => {
  it("posts exactly one comment, credentialed by the vault, on the mission's repo", async () => {
    const { outer, github } = writeRig();
    const res = await handle(outer.deps, post(OP, JSON.stringify(COMMENT_PARAMS)));

    expect(res.status).toBe(200);
    expect(result(res)).toEqual({
      operation: OP,
      effect: "append",
      results: ["upstream ok"],
    });
    expect(github.calls).toHaveLength(1);
    const [call] = github.calls;
    expect(call?.url).toBe(`https://api.github.com${COMMENTS}`);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe('{"body":"Tracked in Linear — thanks."}');
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(github.deps.vendorAuthHeader());
    expect(headers.get("authorization")).not.toMatch(/msr_/);
    expect(headers.get("content-type")).toBe("application/json");
    expect(outer.fetchCount()).toBe(0);
  });

  it("is loud on the record: the inner event says append, allow, the operation, the mission", async () => {
    const { outer, github } = writeRig();
    await handle(outer.deps, post(OP, JSON.stringify(COMMENT_PARAMS)));

    expect(github.events).toEqual([
      expect.objectContaining({
        provider: "github",
        operation: "repos.issues.comments.create",
        action: "append",
        decision: "allow",
        viaOperation: OP,
        missionId: GRANTED.id,
        actor: GRANTED.actor,
      }),
    ]);
    expect(outer.events).toEqual([
      expect.objectContaining({
        operation: "missura.op",
        action: "append",
        decision: "allow",
        viaOperation: OP,
      }),
    ]);
  });

  it("refuses a repo outside the mission as not-found, indistinguishable from a foreign read, and reaches no vendor", async () => {
    const { outer, github } = writeRig();
    const write = await handle(
      outer.deps,
      post(OP, JSON.stringify({ ...COMMENT_PARAMS, repo: "globex/secret" })),
    );
    const read = await handle(
      github.deps,
      request({ method: "GET", path: "/repos/globex/secret/issues/7" }),
    );

    expect(write.status).toBe(404);
    expect(restDenial(write.body).code).toBe("missura_out_of_mission_scope");
    expect(JSON.parse(bodyText(write.body))).toMatchObject({ message: "Not Found" });
    // Same status, same bytes, same headers as a read on that repo: an issue
    // in a foreign repo and an issue that does not exist answer identically.
    expect(write.status).toBe(read.status);
    expect(bodyText(write.body)).toBe(bodyText(read.body));
    expect(write.headers).toEqual(read.headers);
    expect(github.fetchCount()).toBe(0);
    expect(github.events).toContainEqual(
      expect.objectContaining({
        action: "append",
        decision: "deny",
        viaOperation: OP,
      }),
    );
  });

  it("refuses the write when the mission does not name it, before planning, with zero vendor calls", async () => {
    const { outer, github } = writeRig(CLAIMS);
    const res = await handle(outer.deps, post(OP, JSON.stringify(COMMENT_PARAMS)));

    expect(res.status).toBe(403);
    const denial = restDenial(res.body);
    expect(denial.code).toBe("missura_action_not_allowed");
    expect(denial.mission?.allowed_actions).toEqual(["read"]);
    expect(github.fetchCount()).toBe(0);
    expect(github.events).toEqual([]);
  });

  it("is refused by `append` as a verb: only the name grants it", async () => {
    const { outer, github } = writeRig({ ...CLAIMS, allow: ["read", "append"] });
    const res = await handle(outer.deps, post(OP, JSON.stringify(COMMENT_PARAMS)));

    expect(res.status).toBe(403);
    expect(restDenial(res.body).code).toBe("missura_action_not_allowed");
    expect(github.fetchCount()).toBe(0);
  });

  it("never writes on the raw path: the agent's own POST, same token, is not in the catalog", async () => {
    const { github } = writeRig();
    const res = await handle(
      github.deps,
      request({
        method: "POST",
        path: COMMENTS,
        headers: {
          authorization: "Bearer msr_mission_token",
          "content-type": "application/json",
        },
        body: '{"body":"straight to the vendor"}',
      }),
    );

    expect(res.status).toBe(403);
    expect(restDenial(res.body).code).toBe("missura_operation_not_in_catalog");
    expect(github.fetchCount()).toBe(0);
    expect(github.events).toEqual([
      expect.objectContaining({ decision: "deny", operation: "unknown" }),
    ]);
  });

  it("refuses a parameter it cannot build the request from, naming the parameter and nothing else", async () => {
    const { outer, github } = writeRig();
    const res = await handle(
      outer.deps,
      post(OP, JSON.stringify({ ...COMMENT_PARAMS, repo: "globex" })),
    );

    expect(res.status).toBe(400);
    // The route's own refusal, in the listener's own envelope (M7): the
    // agent aimed at the linear port here.
    const denial = graphqlDenial(res.body);
    expect(denial.code).toBe("missura_invalid_parameters");
    expect(denial.reason).toContain("`repo`");
    expect(denial.reason).not.toContain("globex");
    expect(github.fetchCount()).toBe(0);
  });

  it("lists the write on introspection exactly when the mission names it", async () => {
    const ask = request({ method: "GET", path: INTROSPECTION_PATH });
    const granted = await handle(writeRig().outer.deps, ask);
    const plain = await handle(writeRig(CLAIMS).outer.deps, ask);
    const listed = (res: { body: string | Uint8Array }): unknown =>
      (JSON.parse(bodyText(res.body)) as { operations: unknown }).operations;

    expect(listed(granted)).toContainEqual({ name: OP, effect: "append" });
    expect(JSON.stringify(listed(plain))).not.toContain(OP);
  });
});

/**
 * A granted name covers the write its operation declares and nothing wider.
 * Here a READ operation plans the comment POST: the catalog allows the route
 * (it is an inner call), and the pipeline's action check refuses it — the
 * verdict says `append`, the operation behind it says `read`.
 */
describe("a write action is covered only by an operation of that effect", () => {
  const disguised: Operation = {
    name: "github.issues.for_entity",
    connector: "github",
    effect: "read",
    needs: "github.repo",
    plan: (): readonly OperationStep[] => [
      { method: "POST", path: COMMENTS, body: '{"body":"x"}' },
    ],
  };

  it("refuses a read operation whose plan reaches a write route", async () => {
    const { outer, github } = writeRig();
    outer.deps.operations.catalogue = [disguised, GITHUB_COMMENT];
    const res = await handle(outer.deps, post("github.issues.for_entity"));

    expect(res.status).toBe(403);
    expect(restDenial(res.body).code).toBe("missura_action_not_allowed");
    expect(github.fetchCount()).toBe(0);
  });
});
