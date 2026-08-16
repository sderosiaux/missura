import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationSpec } from "./classify";
import type { Observation } from "./exchange";
import { credentials, type Assumption } from "./harness";
import { buildManifest, serializeManifest } from "./manifest";
import { renderReport, type ReportInput } from "./report";
import { forgetLive, rememberAll, scrub } from "./writable";

/**
 * THE BOUNDARY, tested as the boundary.
 *
 * `examples/compat/manifests/*.json` and `report.md` are COMMITTED, under a
 * header that promises no customer identifier is in them. A convention cannot
 * promise that: `redact` at seven call sites means the eighth is the leak, and
 * the eighth was `Assumption.claim`, built from a live organization id.
 *
 * So the rule is not "remember to redact". Nothing reaches an artifact unless
 * it is a literal the suite authored, a placeholder, or a structural descriptor
 * — and both writers pass every string they emit through `scrub` before any
 * byte is produced. This test is what makes that a property: it stuffs a live
 * value into EVERY field an artifact can carry and asserts none of them is in
 * the emitted JSON or markdown.
 *
 * The live values below are fake, and they are registered through the same
 * entry points a real run uses — `credentials()` off the environment, and the
 * `rememberAll` each discovery calls — so this exercises the wiring rather than
 * the scrubber alone.
 */

const LIVE = {
  subdomain: "acme-support",
  email: "helpdesk@acme-support.example",
  apiToken: "zdtok-9f3ab2c7d1e",
  organizationId: "77712345",
  repo: "acme-holdings/private-billing",
  customerId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  ticketId: "9911223",
  nestedPath: "src/customers/acme/secret-config.ts",
  /** A key the TENANT defined, so it is data even though it reads as schema. */
  customKey: "cf_billing_owner",
} as const;

/** The environment a live run would have, with fake values in it. */
function liveEnvironment(): void {
  vi.stubEnv("ZENDESK_SUBDOMAIN", LIVE.subdomain);
  vi.stubEnv("ZENDESK_EMAIL", LIVE.email);
  vi.stubEnv("ZENDESK_API_TOKEN", LIVE.apiToken);
  vi.stubEnv("ZENDESK_ORGANIZATION_ID", LIVE.organizationId);
  vi.stubEnv("GITHUB_TOKEN", "ghp_not-a-real-token");
  vi.stubEnv("MISSURA_GITHUB_REPO", LIVE.repo);
  vi.stubEnv("LINEAR_API_KEY", "lin_api_not-a-real-key");
  vi.stubEnv("MISSURA_LINEAR_CUSTOMER_ID", LIVE.customerId);
  credentials();
  // What discovery learns from the vendor, registered exactly as the discover
  // functions register it.
  rememberAll({ ticketId: LIVE.ticketId, nestedPath: LIVE.nestedPath });
}

const SPEC: OperationSpec = {
  operation: "organizations.tickets.list",
  vendor: "zendesk",
  request: `GET /api/v2/organizations/${LIVE.organizationId}/tickets.json`,
  narrowed: [`the organization ${LIVE.organizationId} is native to the path`],
  filtered: [`tickets of another organization than ${LIVE.organizationId}`],
  refused: [],
  strips: ["next_page"],
};

const ASSUMPTION: Assumption = {
  id: "zendesk.endpoint.organizations.tickets.list",
  vendor: "zendesk",
  claim: `\`organizations.tickets.list\` exists: GET /api/v2/organizations/${LIVE.organizationId}/tickets answers 200 with a root \`tickets\` array`,
  verdict: "HOLDS",
  evidence: `200 for ${LIVE.email} on ${LIVE.subdomain}.zendesk.com`,
  encodedIn: "packages/connectors-zendesk/src/catalog.ts",
};

const OBSERVATION: Observation = {
  operation: "organizations.tickets.list",
  vendor: "zendesk",
  classification: "unsafe",
  reasons: [
    `request rewritten to: GET https://${LIVE.subdomain}.zendesk.com/api/v2/organizations/${LIVE.organizationId}/tickets.json`,
  ],
  unsafe: [
    `field \`organizations.*.organization_fields.${LIVE.customKey}\` is gone from the proxied answer`,
    `the refusal body is not JSON: {"error":"ask ${LIVE.email} about ticket ${LIVE.ticketId}"}`,
  ],
  notes: [`vendor headers not relayed: x-${LIVE.subdomain}-trace`],
  objectsRemoved: 2,
  agentRequest: `GET /repos/${LIVE.repo}/contents/${LIVE.nestedPath}`,
  upstream: `GET /repos/${LIVE.repo}/contents/${encodeURIComponent(LIVE.nestedPath)}?ref=main`,
  upstreamCalls: [
    `GET /api/v2/tickets/${LIVE.ticketId}`,
    `GET /api/v2/organizations/${LIVE.organizationId}/tickets.json`,
  ],
  directStatus: 200,
  proxiedStatus: 200,
};

const INPUT: ReportInput = {
  assumptions: [ASSUMPTION],
  observations: [OBSERVATION],
  skips: {},
  exercised: ["zendesk"],
};

function artifacts(): { json: string; markdown: string } {
  return {
    json: serializeManifest(
      buildManifest("zendesk", [SPEC], [OBSERVATION], [ASSUMPTION]),
    ),
    markdown: renderReport(INPUT),
  };
}

describe("what may be written into a committed artifact", () => {
  afterEach(() => {
    forgetLive();
    vi.unstubAllEnvs();
  });

  it("writes no live value into the manifest or the report", () => {
    liveEnvironment();
    const { json, markdown } = artifacts();

    for (const [name, value] of Object.entries(LIVE)) {
      expect(json, `${name} leaked into the manifest`).not.toContain(value);
      expect(markdown, `${name} leaked into the report`).not.toContain(value);
    }
  });

  /**
   * The manifest's `claim` was the field the convention missed: it is the one
   * place a live target reached a committed file through a string the suite
   * itself wrote.
   */
  it("writes the assumption claim through the boundary like everything else", () => {
    liveEnvironment();
    const { json } = artifacts();

    expect(json).toContain("organizations.tickets.list` exists");
    expect(json).not.toContain(LIVE.organizationId);
  });

  /** A boundary that emptied the artifacts would pass the test above. */
  it("keeps the evidence readable — placeholders, not deletions", () => {
    liveEnvironment();
    const { json, markdown } = artifacts();

    expect(json).toContain("{organizationId}");
    expect(json).toContain("{nestedPath}");
    expect(markdown).toContain("organization_fields.{key}");
    expect(markdown).toContain("organizations.tickets.list");
  });

  /**
   * A tenant-defined key reads exactly like a schema field, so no pattern can
   * tell them apart: the containers whose CHILD KEYS belong to the tenant are
   * named, and everything under one collapses to a descriptor.
   */
  it("collapses a key the tenant defined, without registering it", () => {
    expect(scrub("ticket.organization_fields.whatever_they_called_it")).toBe(
      "ticket.organization_fields.{key}",
    );
    expect(scrub("comments.*.metadata.custom.internal_ref")).toBe(
      "comments.*.metadata.custom.{key}",
    );
    // A vendor path is a vendor path: nothing here touches the schema.
    expect(scrub("tickets.*.organization_id")).toBe("tickets.*.organization_id");
  });

  it("collapses an address nobody registered", () => {
    expect(scrub("contact someone@example.org")).toBe("contact {email}");
  });
});
