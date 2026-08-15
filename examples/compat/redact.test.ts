import { describe, expect, it } from "vitest";
import { redact, redactAll } from "./redact";

/**
 * The report and the manifests are committed. A request target is allowed in
 * them because it is the evidence for what was narrowed; the identifiers inside
 * it are not, because they belong to the human's customers.
 */
describe("redact", () => {
  it("removes a Zendesk organization and ticket id, keeping the shape", () => {
    expect(redact("GET /api/v2/organizations/22989442/tickets.json?per_page=2")).toBe(
      "GET /api/v2/organizations/{id}/tickets.json?per_page=2",
    );
  });

  it("removes a Linear customer UUID", () => {
    expect(
      redact('filter: {customer: {id: {eq: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"}}}'),
    ).toBe('filter: {customer: {id: {eq: "{uuid}"}}}');
  });

  it("keeps a forced search qualifier readable — the narrowing is the point", () => {
    expect(redact("GET /api/v2/search?query=type:ticket+organization:22989442")).toBe(
      "GET /api/v2/search?query=type:ticket+organization:{id}",
    );
  });

  it("leaves page sizes and version segments alone", () => {
    expect(redact("GET /api/v2/tickets?per_page=100&page=3")).toBe(
      "GET /api/v2/tickets?per_page=100&page=3",
    );
  });

  it("drops nothing from a list — a removed entry would hide a finding", () => {
    expect(redactAll(["a 1234", "b"])).toStrictEqual(["a {id}", "b"]);
  });
});
