import { describe, expect, it } from "vitest";
import type { Observation } from "./exchange";
import type { Assumption } from "./harness";
import { failed, renderReport, renderSummary, type ReportInput } from "./report";

function assumption(over: Partial<Assumption> = {}): Assumption {
  return {
    id: "zendesk.search.repeated-organization-ors",
    vendor: "zendesk",
    claim: "repeated `organization:` terms OR",
    verdict: "HOLDS",
    evidence: "the pair returns the sum of the singles",
    encodedIn: "packages/connectors-zendesk/src/narrow-search.ts",
    ...over,
  };
}

function observation(over: Partial<Observation> = {}): Observation {
  return {
    operation: "organizations.tickets.list",
    vendor: "zendesk",
    classification: "compatible",
    reasons: [],
    unsafe: [],
    notes: [],
    objectsRemoved: 0,
    agentRequest: "GET /api/v2/organizations/22989442/tickets.json",
    upstreamCalls: [],
    directStatus: 200,
    proxiedStatus: 200,
    ...over,
  };
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    assumptions: [assumption()],
    observations: [observation()],
    skips: {},
    exercised: ["zendesk"],
    ...over,
  };
}

describe("what fails a run", () => {
  it("passes when nothing is BROKEN and nothing is unsafe", () => {
    expect(failed(input())).toBe(false);
  });

  it("fails on a BROKEN assumption", () => {
    expect(failed(input({ assumptions: [assumption({ verdict: "BROKEN" })] }))).toBe(
      true,
    );
  });

  it("fails on an unsafe operation", () => {
    expect(
      failed(
        input({
          observations: [
            observation({ classification: "unsafe", unsafe: ["a field vanished"] }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("does not fail on UNVERIFIABLE, on a skip, or on a refusal served as one", () => {
    expect(
      failed(
        input({
          assumptions: [assumption({ verdict: "UNVERIFIABLE" })],
          observations: [observation({ classification: "unsupported" })],
        }),
      ),
    ).toBe(false);
  });
});

describe("the report", () => {
  it("names the file to open for every BROKEN assumption", () => {
    const text = renderReport(
      input({
        assumptions: [
          assumption({
            verdict: "BROKEN",
            evidence: "the pair returns nothing while each single returns results",
          }),
        ],
      }),
    );
    expect(text).toContain("This run FAILED");
    expect(text).toContain("packages/connectors-zendesk/src/narrow-search.ts");
  });

  it("redacts every identifier it prints", () => {
    const text = renderReport(
      input({
        observations: [
          observation({
            classification: "compatible_with_rewrite",
            reasons: [
              "request rewritten to: GET /api/v2/search?query=type:ticket+organization:22989442",
            ],
          }),
        ],
      }),
    );
    expect(text).toContain("organization:{id}");
    expect(text).not.toContain("22989442");
  });

  it("says a skipped connector proves nothing rather than leaving it blank", () => {
    const text = renderReport(
      input({
        exercised: [],
        assumptions: [],
        observations: [],
        skips: { linear: "set LINEAR_API_KEY" },
      }),
    );
    expect(text).toContain("Nothing ran");
    expect(text).toContain("set LINEAR_API_KEY");
    expect(text).toContain("A skip proves nothing");
  });

  it("warns beside an unsafe finding when the page was refilled with other records", () => {
    const text = renderReport(
      input({
        observations: [
          observation({
            classification: "unsafe",
            unsafe: ["field `users.*.photo` came back `object` where the vendor sent null"],
            objectsRemoved: 1,
          }),
        ],
      }),
    );
    expect(text).toContain("may describe DIFFERENT records");
  });

  /**
   * The case the caveat was missing from, and the one it matters most in: a
   * TOTAL refill hands back a page as long as the vendor's, so the diff sees no
   * shrink and `objectsRemoved` is 0 — while every record in it may be a
   * different one. Keying the caveat on the shortfall printed it whenever the
   * finding was least likely to be an artefact and withheld it whenever it was
   * most likely to be one.
   */
  it("warns after a total refill too, where nothing came back short", () => {
    const text = renderReport(
      input({
        observations: [
          observation({
            classification: "unsafe",
            unsafe: ["field `users.*.photo` came back `null` where the vendor sent object"],
            objectsRemoved: 0,
            upstreamCalls: [
              "GET /api/v2/organizations/{id}/tickets.json?page=1",
              "GET /api/v2/organizations/{id}/tickets.json?page=2",
            ],
          }),
        ],
      }),
    );
    expect(text).toContain("may describe DIFFERENT records");
  });

  it("says nothing about substitution when one call answered in full", () => {
    const text = renderReport(
      input({
        observations: [
          observation({
            classification: "unsafe",
            unsafe: ["field `users.*.photo` is gone"],
            objectsRemoved: 0,
            upstreamCalls: ["GET /api/v2/users/{id}.json"],
          }),
        ],
      }),
    );
    expect(text).not.toContain("may describe DIFFERENT records");
  });

  it("keeps a pipe inside evidence from breaking the table", () => {
    const text = renderReport(
      input({
        observations: [
          observation({
            classification: "unsafe",
            unsafe: ["field `x` (string|null) is gone"],
          }),
        ],
      }),
    );
    for (const line of text.split("\n")) {
      if (!line.startsWith("| unsafe |")) continue;
      expect(line.split(/(?<!\\)\|/).length - 1).toBe(5);
    }
  });
});

describe("the summary line", () => {
  it("counts verdicts and classifications together", () => {
    expect(renderSummary(input())).toBe("compatible 1  ·  HOLDS 1");
  });

  it("says so when nothing ran", () => {
    expect(
      renderSummary(input({ assumptions: [], observations: [], exercised: [] })),
    ).toBe("nothing ran");
  });
});
