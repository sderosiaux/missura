import { describe, expect, it } from "vitest";
import { createCursorStore } from "./cursor";

const MISSION = "msn_1";

describe("cursor store — handles stand in for vendor positions", () => {
  it("gives back the vendor cursor it was handed", () => {
    const store = createCursorStore();
    const handle = store.issue(MISSION, "arrayconnection:4711");

    expect(store.resolve(MISSION, "arrayconnection:4711")).toBeUndefined();
    expect(store.resolve(MISSION, handle)).toBe("arrayconnection:4711");
  });

  /**
   * The property the whole design exists for: a handle is the same size and
   * shape whatever position it stands for, so nothing about the vendor's
   * position — not its value, not even its length — survives into the answer.
   * An encoded cursor would have failed this one on length alone.
   */
  it("looks identical whatever position it stands for", () => {
    const store = createCursorStore();
    const near = store.issue(MISSION, "arrayconnection:1");
    const far = store.issue(MISSION, "arrayconnection:987654321");

    expect(near).toHaveLength(far.length);
    expect(near).not.toContain("arrayconnection");
    expect(far).not.toContain("987654321");
    expect(near).not.toBe(far);
  });

  it("refuses a handle issued to another mission", () => {
    const store = createCursorStore();
    const handle = store.issue(MISSION, "c1");

    expect(store.resolve("msn_other", handle)).toBeUndefined();
  });

  it("refuses a handle nobody issued", () => {
    const store = createCursorStore();

    expect(store.resolve(MISSION, "not-a-handle")).toBeUndefined();
  });

  it("refuses a handle older than the longest mission", () => {
    let clock = 0;
    const store = createCursorStore({ now: (): number => clock, ttlMs: 1_000 });
    const handle = store.issue(MISSION, "c1");

    clock = 1_001;
    expect(store.resolve(MISSION, handle)).toBeUndefined();
  });

  it("evicts the oldest handles rather than growing without bound", () => {
    const store = createCursorStore({ max: 2 });
    const first = store.issue(MISSION, "c1");
    const second = store.issue(MISSION, "c2");
    const third = store.issue(MISSION, "c3");

    expect(store.resolve(MISSION, first)).toBeUndefined();
    expect(store.resolve(MISSION, second)).toBe("c2");
    expect(store.resolve(MISSION, third)).toBe("c3");
  });
});
