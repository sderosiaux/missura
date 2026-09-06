import type { ResolvedScope } from "@missura/core";
import { describe, expect, it } from "vitest";
import { LINEAR_QUERY, post, rig } from "./operations.fixtures";
import { handle } from "./pipeline";
import {
  bodyText,
  CLAIMS,
  graphqlDenial,
  request,
  restDenial,
} from "./pipeline.fixtures";

/**
 * An operation is refused the way a raw call is refused. For the two claims
 * checks — connector, effect — that means the SAME bytes the raw call gets on
 * that connector: status, body and headers, not just the code. For the two
 * refusals only the route can produce — unknown name, bad parameters — the
 * listener's own envelope, naming nothing the mission does not already know.
 */

describe("the executor refuses like the pipeline refuses", () => {
  it("refuses an unknown name in the listener's own envelope, naming nothing", async () => {
    const { outer, github, linear } = rig();
    const res = await handle(outer.deps, post("zendesk.tickets.for_entity"));

    expect(res.status).toBe(404);
    expect(graphqlDenial(res.body).code).toBe("missura_operation_unknown");
    expect(bodyText(res.body)).not.toContain("zendesk");
    expect(github.fetchCount() + linear.fetchCount()).toBe(0);
    expect(outer.events[0]).toMatchObject({
      decision: "deny",
      operation: "missura.op",
      viaOperation: "zendesk.tickets.for_entity",
    });
  });

  it("refuses a connector outside the mission exactly as the raw call is refused", async () => {
    const narrow = { ...CLAIMS, connections: ["github"] };
    const { outer, linear } = rig({ claims: narrow });
    const op = await handle(outer.deps, post("linear.issues.for_entity"));
    const raw = await handle(
      linear.deps,
      request({ method: "POST", path: "/graphql", body: LINEAR_QUERY }),
    );

    expect(op.status).toBe(403);
    expect(graphqlDenial(op.body).code).toBe("missura_connection_not_in_mission");
    expect(op.status).toBe(raw.status);
    expect(bodyText(op.body)).toBe(bodyText(raw.body));
    expect(op.headers).toEqual(raw.headers);
    expect(linear.fetchCount()).toBe(0);
  });

  it("refuses an effect outside `allow` exactly as the raw call is refused", async () => {
    const searchOnly = { ...CLAIMS, allow: ["search"] };
    const { outer, github } = rig({ claims: searchOnly });
    const op = await handle(outer.deps, post("github.issues.for_entity"));
    const raw = await handle(
      github.deps,
      request({ method: "GET", path: "/repos/acme-corp/product/issues?state=open" }),
    );

    expect(op.status).toBe(403);
    expect(restDenial(op.body).code).toBe("missura_action_not_allowed");
    expect(bodyText(op.body)).toBe(bodyText(raw.body));
    expect(op.headers).toEqual(raw.headers);
    expect(github.fetchCount()).toBe(0);
  });

  /**
   * M9: the refusal names its cause in the agent's own vocabulary — the reason
   * class the token carries for the system, or `not_granted` — and it does so
   * on the raw call too, so the two answers stay the same bytes.
   */
  it("carries the token's reason class as `cause`, on the operation and on the raw call alike", async () => {
    const degraded = {
      ...CLAIMS,
      connections: ["github"],
      degraded: [{ system: "linear" as const, reason: "link_proposed" as const }],
    };
    const { outer, linear } = rig({ claims: degraded });
    const op = await handle(outer.deps, post("linear.issues.for_entity"));
    const raw = await handle(
      linear.deps,
      request({ method: "POST", path: "/graphql", body: LINEAR_QUERY }),
    );

    expect(graphqlDenial(op.body).cause).toBe("link_proposed");
    expect(bodyText(op.body)).toBe(bodyText(raw.body));
    expect(bodyText(op.body).replace(/link_proposed/g, "")).not.toContain("proposed");
  });

  it("carries not_granted as `cause` when the effect is outside `allow`", async () => {
    const { outer } = rig({ claims: { ...CLAIMS, allow: ["search"] } });
    const op = await handle(outer.deps, post("github.issues.for_entity"));

    expect(restDenial(op.body).cause).toBe("not_granted");
  });

  it("refuses a body that is not a parameter object", async () => {
    const { outer, github } = rig();
    const res = await handle(outer.deps, post("github.issues.for_entity", "[1,2]"));

    expect(res.status).toBe(400);
    expect(graphqlDenial(res.body).code).toBe("missura_invalid_parameters");
    expect(github.fetchCount()).toBe(0);
  });

  it("refuses a mission whose scope no longer holds what the operation needs", async () => {
    const { outer, github } = rig({
      resolveScope: (): ResolvedScope => ({ githubRepos: [] }),
    });
    const res = await handle(outer.deps, post("github.issues.for_entity"));

    expect(res.status).toBe(404);
    expect(restDenial(res.body).code).toBe("missura_out_of_mission_scope");
    expect(github.fetchCount()).toBe(0);
  });

  it("refuses before any policy runs when the token is bad, like every route", async () => {
    const { outer, github } = rig();
    outer.deps.verifyToken = (): never => {
      throw new Error("invalid signature");
    };
    const res = await handle(outer.deps, post("github.issues.for_entity"));

    expect(res.status).toBe(401);
    expect(graphqlDenial(res.body).code).toBe("missura_unauthenticated");
    expect(github.fetchCount()).toBe(0);
  });
});
