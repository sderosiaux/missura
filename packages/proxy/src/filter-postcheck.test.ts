import { describe, expect, it } from "vitest";
import { planFromPostCheck } from "./filter";

/**
 * The M2 post-check, expressed as a one-rule plan. It stays until every
 * connector emits plans of its own; these specs pin the translation so the
 * legacy path cannot drift away from the engine that now runs it.
 */

describe("filter engine — legacy post-check plans", () => {
  it("expresses `relation` as an injected field at the object path", () => {
    expect(
      planFromPostCheck({
        path: ["data", "issue", "customer", "id"],
        expectedCustomerId: "c_18",
        injectedSelection: "relation",
      }),
    ).toEqual({
      rules: [
        {
          path: ["data", "issue"],
          type: "unknown",
          ownerPath: ["customer", "id"],
          expectedOwnerIds: ["c_18"],
          ownerMatch: "exact",
          injected: ["customer"],
          nullable: false,
        },
      ],
      strip: [],
    });
  });

  it("expresses `id` as a strip of the widened leaf only", () => {
    const built = planFromPostCheck({
      path: ["data", "issue", "customer", "id"],
      expectedCustomerId: "c_18",
      injectedSelection: "id",
    });

    expect(built.rules[0]?.injected).toEqual([]);
    expect(built.strip).toEqual([["data", "issue", "customer", "id"]]);
  });

  it("expresses `none` as nothing to remove", () => {
    const built = planFromPostCheck({
      path: ["data", "issue", "customer", "id"],
      expectedCustomerId: "c_18",
      injectedSelection: "none",
    });

    expect(built.rules[0]?.injected).toEqual([]);
    expect(built.strip).toEqual([]);
  });
});
