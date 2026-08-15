import { describe, expect, it } from "vitest";
import {
  introspectionQuery,
  readIntrospection,
  readTypeRef,
} from "./introspect";
import {
  readPinnedSchema,
  schemaAssumptions,
  sweep,
  type PinnedField,
  type PinnedSchema,
} from "./linear-schema";
import type { IntrospectedType } from "./introspect";

function type(
  name: string,
  fields: Record<string, boolean>,
): IntrospectedType {
  return {
    name,
    kind: "OBJECT",
    fields: new Map(
      Object.entries(fields).map(([field, nullable]) => [
        field,
        { name: "String", nullable, list: false },
      ]),
    ),
    inputFields: new Map(),
  };
}

describe("readTypeRef", () => {
  it("reads a non-null field as non-null", () => {
    expect(
      readTypeRef({ kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } }),
    ).toStrictEqual({ name: "String", nullable: false, list: false });
  });

  it("reads a nullable list of non-null items as a nullable list", () => {
    expect(
      readTypeRef({
        kind: "LIST",
        ofType: { kind: "NON_NULL", ofType: { kind: "OBJECT", name: "Issue" } },
      }),
    ).toStrictEqual({ name: "Issue", nullable: true, list: true });
  });

  it("does not invent a name it could not read", () => {
    expect(readTypeRef(undefined).name).toBeUndefined();
  });
});

describe("readIntrospection", () => {
  it("keys the answer by type name, not by the alias it travelled under", () => {
    const live = readIntrospection(
      JSON.stringify({
        data: {
          t0: { name: "Issue", kind: "OBJECT", fields: [{ name: "id", type: { kind: "SCALAR", name: "String" } }] },
        },
      }),
    );
    expect(live?.has("Issue")).toBe(true);
  });

  it("returns undefined when introspection is off, rather than an empty schema", () => {
    expect(
      readIntrospection(JSON.stringify({ errors: [{ message: "disabled" }] })),
    ).toBeUndefined();
    expect(readIntrospection("<html>")).toBeUndefined();
  });
});

describe("introspectionQuery", () => {
  it("asks for every type in one POST, aliased", () => {
    const query = introspectionQuery(["Issue", "Customer"], "fields");
    expect(query).toContain('t0: __type(name: "Issue")');
    expect(query).toContain('t1: __type(name: "Customer")');
    expect(query.match(/__type/g)?.length).toBe(2);
  });
});

/**
 * The pinned artifact against a live schema. The three verdicts are separate
 * because they break for different reasons, and a missing type must not also
 * report each of its fields.
 */
describe("the pinned schema sweep", () => {
  const issueFields = new Map<string, PinnedField>([
    ["id", { nullable: false, list: false }],
    ["assignee", { nullable: true, list: false }],
  ]);
  const pinned: PinnedSchema = new Map([
    ["Issue", issueFields],
    ["Ghost", new Map<string, PinnedField>([["x", { nullable: true, list: false }]])],
  ]);

  it("reports a vanished type once, not once per field", () => {
    const found = sweep(pinned, new Map([["Issue", type("Issue", { id: false, assignee: true })]]));
    expect(found.missingTypes).toStrictEqual(["Ghost"]);
    expect(found.missingFields).toStrictEqual([]);
  });

  it("reports a vanished field on a type that still exists", () => {
    const found = sweep(
      new Map([["Issue", issueFields]]),
      new Map([["Issue", type("Issue", { id: false })]]),
    );
    expect(found.missingFields).toStrictEqual(["Issue.assignee"]);
  });

  it("reports nullability that moved, in both directions", () => {
    const found = sweep(
      new Map([["Issue", issueFields]]),
      new Map([["Issue", type("Issue", { id: true, assignee: true })]]),
    );
    expect(found.nullabilityMoved).toStrictEqual([
      "Issue.id (pinned non-null, live nullable)",
    ]);
  });

  it("turns each finding into a BROKEN verdict naming schema.json", () => {
    const verdicts = schemaAssumptions(pinned, new Map(), "introspection");
    expect(verdicts.map((entry) => entry.verdict)).toStrictEqual([
      "BROKEN",
      "HOLDS",
      "HOLDS",
    ]);
    expect(verdicts[0]?.encodedIn).toBe(
      "packages/connectors-linear/src/schema/schema.json",
    );
  });
});

describe("the committed schema artifact", () => {
  it("is readable from disk and carries the type M2 got wrong", () => {
    const pinned = readPinnedSchema();
    const issue = pinned.get("Issue");
    expect(issue?.has("needs")).toBe(true);
    expect(issue?.has("customer")).toBe(false);
  });
});
