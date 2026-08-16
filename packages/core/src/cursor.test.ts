import { describe, expect, it } from "vitest";
import { createCursorStore } from "./cursor";

const MISSION = "msn_1";

/** A plain page boundary: nothing of the page starting there is served yet. */
function at(vendorCursor: string): { vendorCursor: string; served: number } {
  return { vendorCursor, served: 0 };
}

describe("cursor store — handles stand in for vendor positions", () => {
  it("gives back the vendor cursor it was handed", () => {
    const store = createCursorStore();
    const handle = store.issue(MISSION, at("arrayconnection:4711"));

    expect(store.resolve(MISSION, "arrayconnection:4711")).toBeUndefined();
    expect(store.resolve(MISSION, handle)).toEqual({
      vendorCursor: "arrayconnection:4711",
      served: 0,
    });
  });

  /**
   * The property the whole design exists for: a handle is the same size and
   * shape whatever position it stands for, so nothing about the vendor's
   * position — not its value, not even its length — survives into the answer.
   * An encoded cursor would have failed this one on length alone.
   */
  it("looks identical whatever position it stands for", () => {
    const store = createCursorStore();
    const near = store.issue(MISSION, at("arrayconnection:1"));
    const far = store.issue(MISSION, at("arrayconnection:987654321"));

    expect(near).toHaveLength(far.length);
    expect(near).not.toContain("arrayconnection");
    expect(far).not.toContain("987654321");
    expect(near).not.toBe(far);
  });

  /**
   * The same property for the OFFSET, and the reason a REFILL walk may keep one
   * at all: how far into a page the agent is, is a fact about how many objects
   * were hidden from it. It stays on our side of the boundary because a handle
   * is a random value that is a function of neither the position nor the offset.
   */
  it("carries an offset into a page without showing it", () => {
    const store = createCursorStore();
    const boundary = store.issue(MISSION, { vendorCursor: "c1", served: 0 });
    const inside = store.issue(MISSION, { vendorCursor: "c1", served: 41 });

    expect(inside).toHaveLength(boundary.length);
    expect(inside).not.toContain("41");
    expect(inside).not.toBe(boundary);
    expect(store.resolve(MISSION, inside)).toEqual({
      vendorCursor: "c1",
      served: 41,
    });
    expect(store.resolve(MISSION, boundary)?.served).toBe(0);
  });

  it("refuses a handle issued to another mission", () => {
    const store = createCursorStore();
    const handle = store.issue(MISSION, { vendorCursor: "c1", served: 7 });

    expect(store.resolve("msn_other", handle)).toBeUndefined();
  });

  it("refuses a handle nobody issued", () => {
    const store = createCursorStore();

    expect(store.resolve(MISSION, "not-a-handle")).toBeUndefined();
  });

  it("refuses a handle older than the longest mission", () => {
    let clock = 0;
    const store = createCursorStore({ now: (): number => clock, ttlMs: 1_000 });
    const handle = store.issue(MISSION, { vendorCursor: "c1", served: 7 });

    clock = 1_001;
    expect(store.resolve(MISSION, handle)).toBeUndefined();
  });

  it("evicts the oldest handles rather than growing without bound", () => {
    const store = createCursorStore({ max: 2 });
    const first = store.issue(MISSION, at("c1"));
    const second = store.issue(MISSION, at("c2"));
    const third = store.issue(MISSION, { vendorCursor: "c3", served: 2 });

    expect(store.resolve(MISSION, first)).toBeUndefined();
    expect(store.resolve(MISSION, second)?.vendorCursor).toBe("c2");
    expect(store.resolve(MISSION, third)).toEqual({
      vendorCursor: "c3",
      served: 2,
    });
  });
});
