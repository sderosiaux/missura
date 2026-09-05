import { describe, expect, it } from "vitest";
import { assertEntityKey } from "./entity-key";

describe("entity keys", () => {
  it("takes a full key, prefix and all", () => {
    expect(assertEntityKey("customer:adeo")).toBe("customer:adeo");
  });

  it("takes any type, not just customer — that is the whole point", () => {
    expect(assertEntityKey("employee:stephane")).toBe("employee:stephane");
    expect(assertEntityKey("project:atlas")).toBe("project:atlas");
  });

  it("keeps a colon inside the name — the split is on the FIRST one", () => {
    expect(assertEntityKey("project:atlas:eu")).toBe("project:atlas:eu");
  });

  it("refuses an empty key", () => {
    expect(() => assertEntityKey("")).toThrow(/non-empty/i);
  });

  it("refuses a key that is only whitespace", () => {
    expect(() => assertEntityKey("   ")).toThrow(/non-empty/i);
  });

  it("refuses whitespace anywhere inside the key", () => {
    expect(() => assertEntityKey("customer:le roy")).toThrow(/whitespace/i);
    expect(() => assertEntityKey(" customer:adeo")).toThrow(/whitespace/i);
  });

  /**
   * The M5 cutover: `--customer adeo` used to mean `customer:adeo`, and a bare
   * name now means nothing. Refusing it out loud is what keeps a stale habit
   * from silently becoming an entity nobody named.
   */
  it("refuses a bare name and says what a key looks like", () => {
    expect(() => assertEntityKey("adeo")).toThrow(/type:name/);
    expect(() => assertEntityKey("adeo")).toThrow(/customer:adeo/);
  });

  it("refuses a half-empty key", () => {
    expect(() => assertEntityKey(":adeo")).toThrow(/type:name/);
    expect(() => assertEntityKey("customer:")).toThrow(/type:name/);
  });
});
