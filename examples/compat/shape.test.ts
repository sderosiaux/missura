import { describe, expect, it } from "vitest";
import { diffShapes, shapeOf } from "./shape";

/**
 * The shape comparison exists to answer ONE question: would a typed SDK
 * consumer still parse this? So it collapses everything that is allowed to
 * differ (which objects came back, how many) and keeps everything that is not
 * (which fields exist, what type they hold).
 */
describe("shapeOf", () => {
  it("collapses array indices so two pages of different length share paths", () => {
    const shape = shapeOf({ tickets: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect([...shape.keys()]).toStrictEqual(["", "tickets", "tickets.*", "tickets.*.id"]);
  });

  it("keeps every kind a collapsed path produced, not just the first", () => {
    const shape = shapeOf({ items: [{ org: 4 }, { org: null }] });
    expect(shape.get("items.*.org")).toStrictEqual(new Set(["number", "null"]));
  });
});

describe("diffShapes", () => {
  it("calls a page that only lost elements identical in shape", () => {
    const direct = { tickets: [{ id: 1, subject: "a" }, { id: 2, subject: "b" }] };
    const proxied = { tickets: [{ id: 1, subject: "a" }] };
    const diff = diffShapes(direct, proxied);

    expect(diff.missing).toStrictEqual([]);
    expect(diff.retyped).toStrictEqual([]);
    expect(diff.shrunk).toStrictEqual([{ path: "tickets.*", direct: 2, proxied: 1 }]);
  });

  it("does not blame a field that only existed on a dropped element", () => {
    // The removed ticket carried `via`; the surviving one never did. Reporting
    // `via` as a missing field would be the shrink counted twice.
    const direct = { tickets: [{ id: 1 }, { id: 2, via: { channel: "web" } }] };
    const proxied = { tickets: [{ id: 1 }] };
    expect(diffShapes(direct, proxied).missing).toStrictEqual([]);
  });

  it("reports a field removed outside any shrunken list", () => {
    const direct = { tickets: [{ id: 1 }], next_page: "https://x", count: 9 };
    const proxied = { tickets: [{ id: 1 }] };
    const diff = diffShapes(direct, proxied);

    expect(diff.missing.map((m) => m.path)).toStrictEqual(["count", "next_page"]);
  });

  it("reports a kind the proxied body introduced — a nulled field is the case", () => {
    const direct = { issue: { id: "i1", customer: { id: "c1" } } };
    const proxied = { issue: { id: "i1", customer: null } };
    const diff = diffShapes(direct, proxied);

    expect(diff.retyped).toStrictEqual([
      { path: "issue.customer", direct: ["object"], proxied: "null" },
    ]);
    // The subtree under the nulled field went with it; that is the null, not a
    // second finding.
    expect(diff.missing).toStrictEqual([]);
  });

  it("reports a field the proxy added that the vendor never sent", () => {
    const diff = diffShapes({ id: 1 }, { id: 1, missura: { remediation: "x" } });
    expect(diff.added.map((a) => a.path)).toStrictEqual(["missura", "missura.remediation"]);
  });

  it("treats a longer proxied list as a shape difference, never a shrink", () => {
    const diff = diffShapes({ items: [{ id: 1 }] }, { items: [{ id: 1 }, { id: 2 }] });
    expect(diff.shrunk).toStrictEqual([]);
    expect(diff.grew).toStrictEqual([{ path: "items.*", direct: 1, proxied: 2 }]);
  });
});
