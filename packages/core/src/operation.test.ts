import { describe, expect, it } from "vitest";
import {
  operationsFor,
  scopeSatisfies,
  type Operation,
  type OperationStep,
} from "./operation";
import type { ResolvedScope } from "./resolved-scope";
import type { MissionClaims } from "./token";

const NONE: readonly OperationStep[] = [];

/** One read per connector, the M7 shape; the plans are irrelevant here. */
const CATALOGUE: readonly Operation[] = [
  {
    name: "linear.issues.for_entity",
    connector: "linear",
    effect: "read",
    needs: "linear.customer",
    plan: (): readonly OperationStep[] => NONE,
  },
  {
    name: "github.issues.for_entity",
    connector: "github",
    effect: "read",
    needs: "github.repo",
    plan: (): readonly OperationStep[] => NONE,
  },
  {
    name: "zendesk.tickets.for_entity",
    connector: "zendesk",
    effect: "read",
    needs: "zendesk.organization",
    plan: (): readonly OperationStep[] => NONE,
  },
];

const CLAIMS: MissionClaims = {
  id: "msn_1",
  purpose: "test",
  actor: "sam@acme",
  scope: { entity: "customer:acme" },
  connections: ["linear", "github", "zendesk"],
  allow: ["read", "search"],
  degraded: [],
  jti: "jti-1",
  iat: 0,
  exp: 9_999_999_999,
};

describe("scopeSatisfies — what a resolved scope can feed an operation", () => {
  it("needs a linear customer id, a github repo, a zendesk organization", () => {
    const whole: ResolvedScope = {
      linearCustomerId: "c_18",
      githubRepos: [{ repo: "acme-corp/product" }],
      zendeskOrganizationIds: ["4200"],
    };
    expect(scopeSatisfies(whole, "linear.customer")).toBe(true);
    expect(scopeSatisfies(whole, "github.repo")).toBe(true);
    expect(scopeSatisfies(whole, "zendesk.organization")).toBe(true);
  });

  it("reads an empty or absent target as unsatisfied, never as everything", () => {
    const empty: ResolvedScope = { linearCustomerId: "", githubRepos: [] };
    expect(scopeSatisfies(empty, "linear.customer")).toBe(false);
    expect(scopeSatisfies(empty, "github.repo")).toBe(false);
    expect(scopeSatisfies(empty, "zendesk.organization")).toBe(false);
  });
});

describe("operationsFor — the operations THIS mission may run", () => {
  it("lists name and effect of every operation the mission reaches", () => {
    expect(operationsFor(CLAIMS, CATALOGUE)).toEqual([
      { name: "linear.issues.for_entity", effect: "read" },
      { name: "github.issues.for_entity", effect: "read" },
      { name: "zendesk.tickets.for_entity", effect: "read" },
    ]);
  });

  it("leaves out — and never names — an operation on a connector the mission lacks", () => {
    const narrow = { ...CLAIMS, connections: ["github", "zendesk"] };
    const listed = operationsFor(narrow, CATALOGUE);
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("linear");
  });

  it("leaves out an operation whose effect the mission does not allow", () => {
    const append: Operation = {
      name: "zendesk.tickets.comment",
      connector: "zendesk",
      effect: "append",
      needs: "zendesk.organization",
      plan: (): readonly OperationStep[] => NONE,
    };
    const listed = operationsFor(CLAIMS, [...CATALOGUE, append]);
    expect(listed.map((op) => op.name)).not.toContain("zendesk.tickets.comment");
  });

  it("carries nothing but name and effect — not the plan, not the need", () => {
    for (const entry of operationsFor(CLAIMS, CATALOGUE)) {
      expect(Object.keys(entry).sort()).toEqual(["effect", "name"]);
    }
  });
});
