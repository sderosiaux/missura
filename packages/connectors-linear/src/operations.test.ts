import { describe, expect, it } from "vitest";
import { decideLinear } from "./catalog";
import { narrowLinear } from "./narrow";
import { LINEAR_OPERATIONS, issuesForEntity } from "./operations";

/**
 * The Linear read is the `issues` query an agent would write itself: it
 * carries no customer filter, because NARROW injects the mission's — the
 * operation must not know the customer id, and the proof is that its step
 * only names one AFTER the connector's own NARROW rewrote it.
 */

describe("linear.issues.for_entity", () => {
  it("is the one Linear read, and says what it needs", () => {
    expect(LINEAR_OPERATIONS.map((op) => op.name)).toEqual([
      "linear.issues.for_entity",
    ]);
    expect(issuesForEntity).toMatchObject({
      connector: "linear",
      effect: "read",
      needs: "linear.customer",
    });
  });

  it("plans one POST /graphql with a customer-free issues query", () => {
    const steps = issuesForEntity.plan(
      { linearCustomerId: "c_18", githubRepos: [] },
      {},
    );
    expect(steps).toHaveLength(1);
    const [step] = steps;
    expect(step?.method).toBe("POST");
    expect(step?.path).toBe("/graphql");
    expect(step?.body).not.toContain("c_18");
    expect(JSON.parse(step?.body ?? "")).toHaveProperty("query");
  });

  it("plans a step the catalog allows and NARROW scopes to the mission's customer", () => {
    const [step] = issuesForEntity.plan(
      { linearCustomerId: "c_18", githubRepos: [] },
      {},
    );
    if (step === undefined) throw new Error("no step planned");
    expect(decideLinear(step.method, step.path, step.body).decision).toBe("allow");
    const narrowed = narrowLinear(step.body, { linearCustomerId: "c_18" });
    expect(narrowed.decision).toBe("allow");
    expect(narrowed.body).toContain("c_18");
  });

  it("plans a step NARROW refuses under a mission with no Linear customer", () => {
    const [step] = issuesForEntity.plan(
      { linearCustomerId: "c_18", githubRepos: [] },
      {},
    );
    if (step === undefined) throw new Error("no step planned");
    expect(narrowLinear(step.body, {}).decision).toBe("deny");
  });
});
