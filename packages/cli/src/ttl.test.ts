import { describe, expect, it } from "vitest";
import { parseTtl } from "./ttl";

describe("parseTtl", () => {
  it("reads bare seconds, minutes and explicit seconds", () => {
    expect(parseTtl("1800")).toBe(1800);
    expect(parseTtl("30m")).toBe(1800);
    expect(parseTtl("45s")).toBe(45);
  });

  it("falls back when nothing was given", () => {
    expect(parseTtl(undefined, 900)).toBe(900);
  });

  it("refuses a lifetime above the 60 minute cap, naming it", () => {
    expect(() => parseTtl("61m")).toThrow(/3600/);
    expect(() => parseTtl("3601")).toThrow(/3600/);
  });

  it("refuses zero, negatives and junk rather than clamping", () => {
    for (const raw of ["0", "0m", "-1", "-5m", "abc", "30h", "1.5m", ""]) {
      expect(() => parseTtl(raw)).toThrow(/ttl/i);
    }
  });
});
