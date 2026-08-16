import { describe, expect, it } from "vitest";
import { catalogueSpecs } from "./artifacts";
import type { OperationSpec } from "./classify";
import type { Observation } from "./exchange";
import type { Assumption } from "./harness";
import { buildManifest, serializeManifest } from "./manifest";

function spec(over: Partial<OperationSpec> = {}): OperationSpec {
  return {
    operation: "organizations.tickets.list",
    vendor: "zendesk",
    request: "GET /api/v2/organizations/{org}/tickets.json?per_page=2",
    narrowed: ["the organization is native to the path"],
    filtered: ["foreign tickets are dropped"],
    refused: [],
    strips: ["next_page"],
    ...over,
  };
}

function observation(over: Partial<Observation> = {}): Observation {
  return {
    operation: "organizations.tickets.list",
    vendor: "zendesk",
    classification: "compatible_with_filter",
    reasons: ["1 object(s) removed"],
    unsafe: [],
    notes: [],
    objectsRemoved: 1,
    agentRequest: "GET /api/v2/organizations/22989442/tickets.json?per_page=2",
    upstreamCalls: [],
    directStatus: 200,
    proxiedStatus: 200,
    ...over,
  };
}

const ASSUMPTION: Assumption = {
  id: "zendesk.search.organization_id-not-a-qualifier",
  vendor: "zendesk",
  claim: "`organization_id:` is not a search qualifier",
  verdict: "HOLDS",
  evidence: "22989442 returned fewer results than the qualifier did",
  encodedIn: "packages/connectors-zendesk/src/narrow-search.ts",
};

describe("the coverage manifest", () => {
  it("marks an operation no run reached `not_observed`, never compatible", () => {
    const manifest = buildManifest("zendesk", [spec()], [], []);
    expect(manifest.operations[0]?.classification).toBe("not_observed");
    expect(manifest.observed).toBe(false);
  });

  it("carries the connector's own claims whether or not a run happened", () => {
    const [entry] = buildManifest("zendesk", [spec()], [], []).operations;
    expect(entry?.narrowed).toStrictEqual(["the organization is native to the path"]);
    expect(entry?.filtered).toStrictEqual(["foreign tickets are dropped"]);
  });

  /**
   * The narrowing is recorded, and the bytes are what carry it — the boundary
   * is `serializeManifest`, not this call (`writable.ts`). Asserting on the
   * in-memory object would test a convention; asserting on the file tests the
   * file.
   */
  it("records the observed narrowing, through the boundary", () => {
    const text = serializeManifest(
      buildManifest(
        "zendesk",
        [spec()],
        [
          observation({
            classification: "compatible_with_rewrite",
            upstream: "GET /api/v2/organizations/22989442/tickets?per_page=2",
          }),
        ],
        [],
      ),
    );
    expect(text).toContain("GET /api/v2/organizations/{id}/tickets?per_page=2");
    expect(text).not.toContain("22989442");
  });

  it("records unsafe findings, through the boundary, and nothing when there are none", () => {
    const unsafe = serializeManifest(
      buildManifest(
        "zendesk",
        [spec()],
        [
          observation({
            classification: "unsafe",
            unsafe: ["field `tickets.*.subject` is gone (id 22989442)"],
          }),
        ],
        [],
      ),
    );
    expect(unsafe).toContain("field `tickets.*.subject` is gone (id {id})");
    const clean = buildManifest("zendesk", [spec()], [observation()], []);
    expect(clean.operations[0]?.findings).toBeUndefined();
  });

  it("keeps only the assumptions of its own connector", () => {
    const manifest = buildManifest(
      "zendesk",
      [spec()],
      [],
      [ASSUMPTION, { ...ASSUMPTION, id: "linear.x", vendor: "linear" }],
    );
    expect(manifest.assumptions.map((entry) => entry.id)).toStrictEqual([
      ASSUMPTION.id,
    ]);
  });

  it("serializes stably: sorted operations, trailing newline", () => {
    const manifest = buildManifest(
      "zendesk",
      [spec({ operation: "search.list" }), spec({ operation: "organizations.get" })],
      [],
      [],
    );
    const text = serializeManifest(manifest);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("organizations.get")).toBeLessThan(
      text.indexOf("search.list"),
    );
  });
});

/**
 * The catalogue is built from placeholder targets so the manifest is complete
 * whatever a run could reach. If that ever regressed, a repository with no pull
 * requests would ship a manifest that never mentions `repos.pulls.get`.
 */
describe("the committed catalogue", () => {
  it("names every operation, including the ones a run may not be able to aim", () => {
    const specs = catalogueSpecs();
    expect(specs.github.map((entry) => entry.operation)).toContain(
      "repos.pulls.get",
    );
    expect(specs.zendesk.map((entry) => entry.operation)).toContain(
      "tickets.comments.list",
    );
    expect(specs.linear.map((entry) => entry.operation)).toContain("issue");
  });

  it("binds no identifier into a request template", () => {
    for (const specs of Object.values(catalogueSpecs())) {
      for (const entry of specs) {
        expect(entry.request).not.toMatch(/\d{4,}/);
      }
    }
  });

  it("names a refusal for every operation the connectors refuse", () => {
    const zendesk = catalogueSpecs().zendesk.filter(
      (entry) => entry.refused.length > 0,
    );
    expect(zendesk.map((entry) => entry.operation)).toStrictEqual([
      "refused.unscoped_listing",
      "refused.incremental_exports",
      "refused.bulk",
      "refused.admin",
      "refused.attachments",
    ]);
  });
});
