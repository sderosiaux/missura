import { describe, expect, it } from "vitest";
import { applyFilterPlan } from "./filter";
import { ISSUE, ISSUES, list, node, parse, plan } from "./filter.fixtures";

describe("filter engine — lists", () => {
  it("drops every element whose owner is not the mission owner", () => {
    const body = list([
      node("i1", { id: "c_18" }),
      node("i2", { id: "c_globex" }),
      node("i3", { id: "c_18" }),
    ]);
    const out = applyFilterPlan(plan([ISSUES]), body);

    expect(out.ok).toBe(true);
    expect(out.objectsRemoved).toBe(1);
    expect(parse(out.body)).toEqual({
      data: { issues: { nodes: [{ id: "i1" }, { id: "i3" }] } },
    });
    expect(out.body).not.toContain("c_globex");
  });

  it("treats an element whose owner cannot be resolved as foreign", () => {
    const body = list([
      node("i1", { id: "c_18" }),
      { id: "i2" },
      node("i3", null),
      node("i4", { id: 42 }),
      "not-an-object",
    ]);
    const out = applyFilterPlan(plan([ISSUES]), body);

    expect(out.objectsRemoved).toBe(4);
    expect(parse(out.body)).toEqual({
      data: { issues: { nodes: [{ id: "i1" }] } },
    });
  });

  it("counts every removed object across rules", () => {
    const body = JSON.stringify({
      data: {
        issues: { nodes: [node("i1", { id: "c_globex" })] },
        issue: node("i9", { id: "c_globex" }),
      },
    });
    const out = applyFilterPlan(plan([ISSUES, ISSUE]), body);

    expect(out.objectsRemoved).toBe(2);
    expect(parse(out.body)).toEqual({
      data: { issues: { nodes: [] }, issue: null },
    });
  });
});

describe("filter engine — single objects", () => {
  it("replaces a foreign object with null when the field is nullable", () => {
    const body = JSON.stringify({
      data: { issue: node("i1", { id: "c_globex" }) },
    });
    const out = applyFilterPlan(plan([ISSUE]), body);

    expect(out.ok).toBe(true);
    expect(out.objectsRemoved).toBe(1);
    expect(parse(out.body)).toEqual({ data: { issue: null } });
  });

  it("fails closed rather than return a foreign non-nullable object", () => {
    const body = JSON.stringify({
      data: { issue: node("i1", { id: "c_globex" }) },
    });
    const out = applyFilterPlan(plan([{ ...ISSUE, nullable: false }]), body);

    expect(out.ok).toBe(false);
    expect(out.body).toBe('{"errors":[{"message":"issue not found"}]}');
    expect(out.body).not.toContain("c_globex");
  });

  it("fails closed on an unresolvable owner at a non-nullable path", () => {
    const body = JSON.stringify({ data: { issue: { id: "i1" } } });
    const out = applyFilterPlan(plan([{ ...ISSUE, nullable: false }]), body);

    expect(out.ok).toBe(false);
  });

  it("leaves an absent object alone — the vendor returned nothing to leak", () => {
    const body = JSON.stringify({ data: { issue: null } });
    const out = applyFilterPlan(plan([{ ...ISSUE, nullable: false }]), body);

    expect(out.ok).toBe(true);
    expect(out.body).toBe(body);
    expect(out.objectsRemoved).toBe(0);
  });
});

describe("filter engine — stripping", () => {
  it("strips the injected discriminator at the rule path", () => {
    const body = JSON.stringify({
      data: { issue: { id: "i1", customer: { id: "c_18" } } },
    });
    const out = applyFilterPlan(plan([ISSUE]), body);

    expect(parse(out.body)).toEqual({ data: { issue: { id: "i1" } } });
  });

  it("keeps a discriminator the agent asked for itself", () => {
    const body = JSON.stringify({
      data: { issue: { id: "i1", customer: { id: "c_18" } } },
    });
    const out = applyFilterPlan(plan([{ ...ISSUE, injected: [] }]), body);

    expect(out.body).toBe(body);
  });

  it("strips an explicit path, inside list elements too", () => {
    const body = list([
      { ...node("i1", { id: "c_18" }), secret: "x" },
      { ...node("i2", { id: "c_18" }), secret: "y" },
    ]);
    const out = applyFilterPlan(
      plan(
        [{ ...ISSUES, injected: [] }],
        [["data", "issues", "nodes", "*", "secret"]],
      ),
      body,
    );

    expect(parse(out.body)).toEqual({
      data: {
        issues: {
          nodes: [
            { id: "i1", customer: { id: "c_18" } },
            { id: "i2", customer: { id: "c_18" } },
          ],
        },
      },
    });
  });

  it("strips only the injected leaf when the agent asked for the relation", () => {
    const body = JSON.stringify({
      data: { issue: { id: "i1", customer: { name: "Acme", id: "c_18" } } },
    });
    const out = applyFilterPlan(
      plan([{ ...ISSUE, injected: [] }], [["data", "issue", "customer", "id"]]),
      body,
    );

    expect(parse(out.body)).toEqual({
      data: { issue: { id: "i1", customer: { name: "Acme" } } },
    });
  });
});

describe("filter engine — untouched responses", () => {
  it("returns a response with no matching rule byte for byte", () => {
    const body = '{"data":{"viewer":{"name":"Ada","id":"u1"}}}';
    const out = applyFilterPlan(plan([ISSUES, ISSUE]), body);

    expect(out.ok).toBe(true);
    expect(out.body).toBe(body);
    expect(out.objectsRemoved).toBe(0);
  });

  it("returns an all-authorized list byte for byte", () => {
    const body = list([node("i1", { id: "c_18" })]);
    const out = applyFilterPlan(plan([{ ...ISSUES, injected: [] }]), body);

    expect(out.body).toBe(body);
  });

  it("fails closed on a body that is not JSON", () => {
    const out = applyFilterPlan(plan([ISSUE]), "upstream ok");

    expect(out.ok).toBe(false);
    expect(out.body).toBe('{"errors":[{"message":"issue not found"}]}');
  });

  it("fails closed on a truncated JSON body", () => {
    const out = applyFilterPlan(plan([ISSUE]), '{"data":{"issue":');

    expect(out.ok).toBe(false);
  });
});
