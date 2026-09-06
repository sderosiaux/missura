import { describe, expect, it } from "vitest";
import {
  actionCovered,
  grantableOperations,
  operationAllowed,
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

  it("leaves out a write the mission does not grant by NAME", () => {
    const listed = operationsFor(CLAIMS, [...CATALOGUE, APPEND]);
    expect(listed.map((op) => op.name)).not.toContain("zendesk.tickets.comment");
    // The verb alone grants nothing: a write is never covered by its effect.
    const byVerb = { ...CLAIMS, allow: ["read", "search", "append"] };
    expect(operationsFor(byVerb, [...CATALOGUE, APPEND]).map((op) => op.name)).not.toContain(
      "zendesk.tickets.comment",
    );
  });

  it("lists a write exactly when its name is in `allow`, with its effect", () => {
    const granted = { ...CLAIMS, allow: ["read", "search", "zendesk.tickets.comment"] };
    expect(operationsFor(granted, [...CATALOGUE, APPEND])).toContainEqual({
      name: "zendesk.tickets.comment",
      effect: "append",
    });
  });

  it("carries nothing but name and effect — not the plan, not the need", () => {
    for (const entry of operationsFor(CLAIMS, CATALOGUE)) {
      expect(Object.keys(entry).sort()).toEqual(["effect", "name"]);
    }
  });
});

const APPEND: Operation = {
  name: "zendesk.tickets.comment",
  connector: "zendesk",
  effect: "append",
  needs: "zendesk.organization",
  plan: (): readonly OperationStep[] => NONE,
};

const READ = CATALOGUE[0];
if (READ === undefined) throw new Error("no read operation in the catalogue");

/**
 * THE M8 GRANT RULE. `allow` lists verbs for the raw read path and NAMES for
 * writes: a read operation runs under `read`, a write runs only under its own
 * exact name. No verb ever grants a write, so a token that says `append` grants
 * nothing more than one that does not.
 */
describe("operationAllowed — reads by verb, writes by name", () => {
  it("covers a read operation by the `read` verb", () => {
    expect(operationAllowed(CLAIMS, READ)).toBe(true);
    expect(operationAllowed({ ...CLAIMS, allow: ["search"] }, READ)).toBe(false);
  });

  it("covers a write by its exact name, and never by its effect", () => {
    expect(operationAllowed(CLAIMS, APPEND)).toBe(false);
    expect(operationAllowed({ ...CLAIMS, allow: ["read", "append"] }, APPEND)).toBe(false);
    expect(
      operationAllowed({ ...CLAIMS, allow: ["read", "zendesk.tickets.comment"] }, APPEND),
    ).toBe(true);
    expect(
      operationAllowed({ ...CLAIMS, allow: ["zendesk.tickets.Comment"] }, APPEND),
    ).toBe(false);
  });
});

/**
 * The pipeline's own action check, on ONE request. A read/search verdict is
 * covered by the verb. A write verdict is covered only on the inner call of an
 * operation of that same effect whose name the mission grants — so a granted
 * write cannot be spent on a route its operation never planned, and a raw
 * request (no operation behind it) is never covered at all.
 */
describe("actionCovered — a write action is only ever an operation's own inner call", () => {
  const granted = { ...CLAIMS, allow: ["read", "zendesk.tickets.comment"] };

  it("covers read and search by verb, with or without an operation behind", () => {
    expect(actionCovered(CLAIMS, "read", undefined)).toBe(true);
    expect(actionCovered(CLAIMS, "search", READ)).toBe(true);
    expect(actionCovered({ ...CLAIMS, allow: ["search"] }, "read", READ)).toBe(false);
  });

  it("never covers a write with no operation behind the request", () => {
    expect(actionCovered(granted, "append", undefined)).toBe(false);
    expect(actionCovered({ ...CLAIMS, allow: ["append"] }, "append", undefined)).toBe(false);
  });

  it("covers a write only under a granted operation OF THAT EFFECT", () => {
    expect(actionCovered(granted, "append", APPEND)).toBe(true);
    // Not granted by name.
    expect(actionCovered(CLAIMS, "append", APPEND)).toBe(false);
    // Granted, but a read operation's inner call turned into a write.
    expect(actionCovered(granted, "append", READ)).toBe(false);
    // Granted append, but the route wants a stronger effect.
    expect(actionCovered(granted, "mutate", APPEND)).toBe(false);
  });
});

/**
 * What a mint may add to `allow`. Checked against the catalogue where the
 * grant is written, so a typo fails loudly instead of minting a name that
 * matches nothing — and a read's name is refused too, because reads are
 * granted by the verb and a name-grant for one would be a second spelling of
 * the same thing.
 */
describe("grantableOperations — names a mint may put in `allow`", () => {
  const catalogue = [...CATALOGUE, APPEND];

  it("accepts a catalogued write, deduplicated", () => {
    expect(
      grantableOperations(
        ["zendesk.tickets.comment", "zendesk.tickets.comment"],
        catalogue,
      ),
    ).toEqual(["zendesk.tickets.comment"]);
    expect(grantableOperations([], catalogue)).toEqual([]);
  });

  it("refuses a name that is not in the catalogue, naming it", () => {
    expect(() => grantableOperations(["zendesk.tickets.coment"], catalogue)).toThrow(
      "unknown operation: zendesk.tickets.coment",
    );
    expect(() => grantableOperations(["zendesk.tickets.comment"], [])).toThrow(
      "unknown operation: zendesk.tickets.comment",
    );
  });

  it("refuses a read's name and a bare verb: reads are granted by `read`", () => {
    expect(() => grantableOperations([READ.name], catalogue)).toThrow(/read/);
    expect(() => grantableOperations(["append"], catalogue)).toThrow(
      "unknown operation: append",
    );
  });
});
