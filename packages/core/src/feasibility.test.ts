import { describe, expect, it } from "vitest";
import { entityGraphReader, parseEntityGraph } from "./entity-graph-store";
import {
  agentCause,
  agentFeasibility,
  assertGrantable,
  feasibilityReport,
  OperationGapError,
  type FeasibilityReport,
} from "./feasibility";
import type { Operation, OperationStep } from "./operation";
import type { MissionClaims } from "./token";

const NONE: readonly OperationStep[] = [];

/** One read per connector and the one write, the shipped shape. */
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
    name: "github.issue.comment.create",
    connector: "github",
    effect: "append",
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

const CONFIRMED = {
  evidence: "operator",
  method: "manual",
  status: "confirmed",
  confirmedBy: "ops@missura.dev",
} as const;

/**
 * `customer:zoetis`: Linear proposed, the rest confirmed. `customer:initech`:
 * no GitHub link at all, and a Linear link a human rejected.
 */
const GRAPH = entityGraphReader(
  parseEntityGraph(
    {
      version: 1,
      entities: {
        "customer:zoetis": {
          displayName: "Zoetis",
          domains: ["zoetis.example"],
          links: [
            {
              system: "linear",
              id: "c_77",
              evidence: "name matches",
              method: "inferred",
              status: "proposed",
            },
            { system: "github", id: "acme-corp/zoetis", ...CONFIRMED },
            { system: "zendesk", id: "4300", ...CONFIRMED },
          ],
        },
        "customer:initech": {
          displayName: "Initech",
          domains: ["initech.example"],
          links: [
            {
              system: "linear",
              id: "c_55",
              evidence: "name matches",
              method: "inferred",
              status: "rejected",
            },
            { system: "zendesk", id: "4400", ...CONFIRMED },
          ],
        },
      },
    },
    "feasibility fixtures",
  ),
);

const ALL = ["linear", "github", "zendesk"] as const;

function report(
  entity: string,
  over: { connected?: readonly ("linear" | "github" | "zendesk")[]; allow?: readonly string[] } = {},
): FeasibilityReport {
  return feasibilityReport({
    reader: GRAPH,
    entity,
    catalogue: CATALOGUE,
    connected: over.connected ?? ALL,
    allow: over.allow ?? ["github.issue.comment.create"],
  });
}

function entry(r: FeasibilityReport, name: string): FeasibilityReport["operations"][number] {
  const found = r.operations.find((op) => op.name === name);
  if (found === undefined) throw new Error(`no entry for ${name}`);
  return found;
}

describe("feasibilityReport — per operation, possible or ONE gap", () => {
  it("lists what a whole grant on the entity can run, and the one gap with its status", () => {
    const r = report("customer:zoetis");
    expect(r.entity).toBe("customer:zoetis");
    expect(r.operations.filter((op) => op.possible).map((op) => op.name)).toEqual([
      "github.issues.for_entity",
      "github.issue.comment.create",
      "zendesk.tickets.for_entity",
    ]);
    expect(entry(r, "linear.issues.for_entity")).toMatchObject({
      possible: false,
      system: "linear",
      cause: "link_not_confirmed",
      status: "proposed",
    });
  });

  it("names the status the link actually has, not a generic 'unconfirmed'", () => {
    expect(entry(report("customer:initech"), "linear.issues.for_entity")).toMatchObject({
      cause: "link_not_confirmed",
      status: "rejected",
    });
  });

  it("reports no_link for a system the entity has no link to, on every operation of it", () => {
    const r = report("customer:initech");
    expect(entry(r, "github.issues.for_entity")).toMatchObject({
      cause: "no_link",
      system: "github",
    });
    expect(entry(r, "github.issue.comment.create")).toMatchObject({
      cause: "no_link",
      system: "github",
    });
  });

  it("reports system_not_connected first, before anything the graph says", () => {
    const r = report("customer:zoetis", { connected: ["linear", "github"] });
    // The link is confirmed; the deployment still has no Zendesk.
    expect(entry(r, "zendesk.tickets.for_entity")).toMatchObject({
      cause: "system_not_connected",
      system: "zendesk",
    });
    // And an unconfirmed link on a disconnected system is still "not connected".
    const narrow = report("customer:zoetis", { connected: ["github", "zendesk"] });
    expect(entry(narrow, "linear.issues.for_entity")).toMatchObject({
      cause: "system_not_connected",
    });
    expect("status" in entry(narrow, "linear.issues.for_entity")).toBe(false);
  });

  it("reports not_granted only when everything else is in place", () => {
    const r = report("customer:zoetis", { allow: [] });
    expect(entry(r, "github.issue.comment.create")).toMatchObject({
      cause: "not_granted",
      system: "github",
      effect: "append",
    });
    // A read is granted by the verb: never not_granted.
    expect(entry(r, "github.issues.for_entity")).toMatchObject({ possible: true });
    // Precedence: no link beats no grant.
    expect(entry(report("customer:initech", { allow: [] }), "github.issue.comment.create")).toMatchObject({
      cause: "no_link",
    });
  });

  it("carries one remediation per gap, naming the command that closes it", () => {
    const zoetis = report("customer:zoetis", { allow: [] });
    expect(entry(zoetis, "linear.issues.for_entity")).toMatchObject({
      remediation: expect.stringContaining("missura entity confirm customer:zoetis linear") as string,
    });
    expect(entry(zoetis, "github.issue.comment.create")).toMatchObject({
      remediation: expect.stringContaining(
        "missura exec --entity customer:zoetis --allow github.issue.comment.create",
      ) as string,
    });
    expect(entry(report("customer:initech"), "github.issues.for_entity")).toMatchObject({
      remediation: expect.stringContaining("missura entity link customer:initech github") as string,
    });
    expect(
      entry(report("customer:zoetis", { connected: ["github"] }), "zendesk.tickets.for_entity"),
    ).toMatchObject({ remediation: expect.stringContaining("missura init") as string });
  });

  it("refuses an entity the graph does not hold", () => {
    expect(() => report("customer:globex")).toThrow("unknown entity: customer:globex");
  });
});

describe("assertGrantable — the mint's question, answered as the gap", () => {
  it("passes when every requested name is possible", () => {
    expect(() =>
      { assertGrantable(report("customer:zoetis"), ["github.issue.comment.create"]); },
    ).not.toThrow();
  });

  it("throws the FIRST gap among the requested names, with cause, system and remediation", () => {
    const r = report("customer:initech");
    let caught: unknown;
    try {
      assertGrantable(r, ["github.issue.comment.create"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OperationGapError);
    const error = caught as OperationGapError;
    expect(error.gap).toMatchObject({
      name: "github.issue.comment.create",
      cause: "no_link",
      system: "github",
    });
    expect(error.message).toContain("no_link");
    expect(error.message).toContain("missura entity link customer:initech github");
  });

  it("says nothing about a name the catalogue does not hold — that is the store's refusal", () => {
    expect(() => { assertGrantable(report("customer:zoetis"), ["github.issue.coment.create"]); }).not.toThrow();
  });
});

/**
 * THE AGENT PROJECTION. The operator's report names systems, link statuses
 * and remediation commands. The agent's view is built from the same report
 * and its own claims — and may hold nothing the claims do not already:
 * systems in the mission or degraded on it, reason classes, and `not_granted`.
 */
describe("agentFeasibility — the agent's projection, from its claims", () => {
  const zoetis: MissionClaims = {
    id: "msn_1",
    purpose: "test",
    actor: "sam@acme",
    scope: { entity: "customer:zoetis" },
    connections: ["github", "zendesk"],
    allow: ["read", "search"],
    degraded: [{ system: "linear", reason: "link_proposed" }],
    jti: "jti-1",
    iat: 0,
    exp: 9_999_999_999,
  };

  it("names a possible read, a not_granted write, and a degraded system by reason class", () => {
    expect(agentFeasibility(report("customer:zoetis"), zoetis)).toEqual([
      { name: "linear.issues.for_entity", effect: "read", possible: false, cause: "link_proposed" },
      { name: "github.issues.for_entity", effect: "read", possible: true },
      { name: "github.issue.comment.create", effect: "append", possible: false, cause: "not_granted" },
      { name: "zendesk.tickets.for_entity", effect: "read", possible: true },
    ]);
  });

  it("never carries a link status, a native id, a remediation, or a system outside the mission", () => {
    // initech's mission: zendesk only; linear rejected (degraded), github absent (no link).
    const initech: MissionClaims = {
      ...zoetis,
      scope: { entity: "customer:initech" },
      connections: ["zendesk"],
      degraded: [{ system: "linear", reason: "link_rejected" }],
    };
    const projected = agentFeasibility(report("customer:initech"), initech);
    const text = JSON.stringify(projected);
    const known = new Set([...initech.connections, ...initech.degraded.map((d) => d.system)]);
    for (const system of ALL) {
      if (!known.has(system)) expect(text).not.toContain(system);
    }
    for (const word of ["proposed", "confirmed", "rejected", "broken", "c_55", "4400", "missura", "remediation", "status"]) {
      expect(text.replace(/link_rejected/g, "")).not.toContain(word);
    }
    expect(projected.map((op) => op.name)).toEqual([
      "linear.issues.for_entity",
      "zendesk.tickets.for_entity",
    ]);
  });

  it("says nothing about a system the deployment never connected", () => {
    const projected = agentFeasibility(report("customer:zoetis", { connected: ["github", "linear"] }), zoetis);
    expect(JSON.stringify(projected)).not.toContain("zendesk");
  });
});

describe("agentCause — what a refusal may say about why", () => {
  const claims = {
    connections: ["github"],
    degraded: [{ system: "linear" as const, reason: "link_broken" as const }],
  };

  it("maps an action refusal to not_granted and a connection refusal to the token's reason", () => {
    expect(agentCause("missura_action_not_allowed", "github", claims)).toBe("not_granted");
    expect(agentCause("missura_connection_not_in_mission", "linear", claims)).toBe("link_broken");
  });

  it("says nothing when the token holds no reason, and nothing on other codes", () => {
    expect(agentCause("missura_connection_not_in_mission", "zendesk", claims)).toBeUndefined();
    expect(agentCause("missura_connection_not_in_mission", "linear", undefined)).toBeUndefined();
    expect(agentCause("missura_out_of_mission_scope", "linear", claims)).toBeUndefined();
  });
});
