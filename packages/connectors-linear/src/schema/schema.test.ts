import { describe, expect, it } from "vitest";
import { SCHEMA_SDK_VERSION, excludedFields, fieldInfo, knownType } from "./schema";

describe("fieldInfo reads the pinned artifact", () => {
  it("returns the Team type and the SDK's nullability for `Issue.team`", () => {
    // `private _team;` — not optional — so `Issue.team: Team!`.
    expect(fieldInfo("Issue", "team")).toEqual({
      type: "Team",
      nullable: false,
      list: false,
    });
  });

  it("returns nullable for a relation the SDK declares optional", () => {
    // `private _assignee?;` — optional — so `Issue.assignee: User`.
    expect(fieldInfo("Issue", "assignee")).toEqual({
      type: "User",
      nullable: true,
      list: false,
    });
  });

  it("marks a list field as a list", () => {
    expect(fieldInfo("Issue", "reactions")).toEqual({
      type: "Reaction",
      nullable: false,
      list: true,
    });
    expect(fieldInfo("IssueConnection", "nodes")).toEqual({
      type: "Issue",
      nullable: false,
      list: true,
    });
  });

  it("returns undefined for an unknown type", () => {
    expect(fieldInfo("Nope", "id")).toBeUndefined();
  });

  it("returns undefined for an unknown field on a known type", () => {
    expect(fieldInfo("Issue", "nope")).toBeUndefined();
  });

  it("returns undefined for a field the extractor refused to map", () => {
    // `metadata?: ExternalEntityInfoFragment["metadata"] | null` is a union
    // behind an indexed access — unnameable from the class declaration.
    expect(fieldInfo("ExternalEntityInfo", "metadata")).toBeUndefined();
    // `teamId` is `this._team?.id` inside the SDK, not a vendor field.
    expect(fieldInfo("Issue", "teamId")).toBeUndefined();
  });

  it("resolves prototype-named fields by own property only", () => {
    expect(fieldInfo("Issue", "constructor")).toBeUndefined();
    expect(fieldInfo("Issue", "__proto__")).toBeUndefined();
    expect(fieldInfo("constructor", "id")).toBeUndefined();
  });

  it("knows leaf types but gives them no fields, so nothing can be walked into them", () => {
    expect(knownType("string")).toBe(true);
    expect(knownType("JSONObject")).toBe(true);
    expect(fieldInfo("string", "length")).toBeUndefined();
  });

  it("does NOT know `Issue.customer` — the SDK declares no such field", () => {
    // Recorded on purpose. `ownerPath("Issue")` is `["customer","id"]` per the
    // M3 plan, but @linear/sdk 90 declares neither `Issue.customer` nor
    // `IssueFilter.customer`: the customer link runs through `Issue.needs`
    // (CustomerNeed). Task 2 must resolve this before the injected
    // discriminator can reach the vendor.
    expect(fieldInfo("Issue", "customer")).toBeUndefined();
    expect(fieldInfo("Issue", "needs")).toEqual({
      type: "CustomerNeedConnection",
      nullable: false,
      list: false,
    });
  });
});

describe("the artifact describes itself", () => {
  it("names the SDK version it was extracted from", () => {
    expect(SCHEMA_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("keeps the reason a field was refused, so a deny can say why", () => {
    expect(excludedFields("ExternalEntityInfo").metadata).toBe("unmapped-type");
    expect(excludedFields("Team").organization).toBe("unbacked-getter");
    expect(excludedFields("Issue").teamId).toBe("synthesized-id-getter");
    expect(excludedFields("Issue").update).toBe("non-query-method");
    expect(excludedFields("Nope")).toEqual({});
  });
});
