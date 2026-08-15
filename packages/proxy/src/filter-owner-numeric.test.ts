import type { FilterRule } from "@missura/core";
import { describe, expect, it } from "vitest";
import { isOwned } from "./filter-owner";

/**
 * An owner id the vendor publishes as a NUMBER.
 *
 * Zendesk's `organization_id` is an integer, not a string — a ticket answers
 * `"organization_id": 22989442`. A rule whose leaf only ever resolves through
 * a string would prove nothing about any Zendesk object, so every one of them
 * would be foreign and the connector would filter its own answers away.
 *
 * The widening is bounded on purpose. Only a SAFE INTEGER resolves: a float
 * would compare `1.0` equal to a mission's `1`, and an integer past
 * `Number.MAX_SAFE_INTEGER` stringifies lossily — `9007199254740993` becomes
 * `"9007199254740992"`, i.e. a different object's id. A comparison that can
 * name the wrong object is worse than one that resolves nothing.
 */

function rule(expected: readonly string[]): FilterRule {
  return {
    path: ["tickets", "*"],
    type: "ticket",
    ownerPath: ["organization_id"],
    expectedOwnerIds: expected,
    ownerMatch: "exact",
    injected: [],
    nullable: false,
  };
}

const MINE = rule(["22989442"]);

describe("isOwned — a numeric owner id", () => {
  it("proves an object whose owner is an integer", () => {
    expect(isOwned({ organization_id: 22989442 }, MINE)).toBe(true);
  });

  it("does not prove an object owned by another integer", () => {
    expect(isOwned({ organization_id: 22989443 }, MINE)).toBe(false);
  });

  it("treats a null discriminator as foreign", () => {
    expect(isOwned({ organization_id: null }, MINE)).toBe(false);
  });

  it("treats a missing discriminator as foreign", () => {
    expect(isOwned({}, MINE)).toBe(false);
  });

  it("refuses a float rather than rounding it into a match", () => {
    expect(isOwned({ organization_id: 22989442.5 }, MINE)).toBe(false);
    expect(isOwned({ organization_id: 1.0 }, rule(["1"]))).toBe(true);
  });

  it("refuses an integer too large to stringify without loss", () => {
    // `String(9007199254740993) === "9007199254740992"`: a different object.
    expect(
      isOwned({ organization_id: 9007199254740993 }, rule(["9007199254740992"])),
    ).toBe(false);
  });

  it("refuses NaN and Infinity", () => {
    expect(isOwned({ organization_id: Number.NaN }, rule(["NaN"]))).toBe(false);
    expect(
      isOwned({ organization_id: Number.POSITIVE_INFINITY }, rule(["Infinity"])),
    ).toBe(false);
  });

  it("does not let a boolean stand in for an id", () => {
    expect(isOwned({ organization_id: true }, rule(["true"]))).toBe(false);
  });

  it("still resolves a string leaf unchanged", () => {
    expect(isOwned({ organization_id: "22989442" }, MINE)).toBe(true);
    expect(isOwned({ organization_id: "" }, rule([""]))).toBe(false);
  });
});
