import { describe, expect, it } from "vitest";
import {
  CONNECTION_TYPES,
  CUSTOMER_SCOPED_CONNECTIONS,
  CUSTOMER_SCOPED_TYPES,
  METADATA_CUSTOMER_COLLECTIONS,
  METADATA_NON_NULLABLE_CUSTOMER_SINGLES,
  METADATA_OBJECT_TYPES,
  METADATA_SAFETY,
  METADATA_TYPES,
  ownerPath,
  typeClass,
} from "./classification";
import { fieldInfo, knownType, schemaFieldNames, typeNames } from "./schema";

describe("typeClass", () => {
  it("classifies the customer-scoped types", () => {
    expect(typeClass("Issue")).toBe("customer-scoped");
    expect(typeClass("Customer")).toBe("customer-scoped");
    expect(typeClass("Comment")).toBe("customer-scoped");
    expect(typeClass("Attachment")).toBe("customer-scoped");
    expect(typeClass("CustomerNeed")).toBe("customer-scoped");
  });

  it("classifies the metadata types and the connection wrappers", () => {
    expect(typeClass("Team")).toBe("metadata");
    expect(typeClass("PageInfo")).toBe("metadata");
    expect(typeClass("IssueConnection")).toBe("metadata");
  });

  it("classifies every leaf type as metadata — a leaf has no fields to walk into", () => {
    expect(typeClass("string")).toBe("metadata");
    expect(typeClass("JSONObject")).toBe("metadata");
    expect(fieldInfo("string", "anything")).toBeUndefined();
  });

  it("denies an unknown type", () => {
    expect(typeClass("Nope")).toBe("denied");
    expect(typeClass("")).toBe("denied");
  });

  it("denies a type that exists in the SDK but was never classified", () => {
    expect(typeClass("Document")).toBe("denied");
    expect(typeClass("IssueHistory")).toBe("denied");
    expect(typeClass("Roadmap")).toBe("denied");
    expect(typeClass("ProjectAttachment")).toBe("denied");
  });

  it("denies a prototype-named type rather than resolving through Object.prototype", () => {
    expect(typeClass("constructor")).toBe("denied");
    expect(typeClass("__proto__")).toBe("denied");
    expect(typeClass("toString")).toBe("denied");
  });
});

describe("ownerPath", () => {
  it("gives the route from each customer-scoped type to its owning customer id", () => {
    // Through the `needs` COLLECTION, because `Issue.customer` does not exist:
    // any need naming the mission's customer makes the issue ours (§4.4.3).
    const issue = ["needs", "nodes", "*", "customer", "id"];
    expect(ownerPath("Issue")).toEqual(issue);
    expect(ownerPath("Comment")).toEqual(["issue", ...issue]);
    expect(ownerPath("Attachment")).toEqual(["issue", ...issue]);
    expect(ownerPath("Customer")).toEqual(["id"]);
    expect(ownerPath("CustomerNeed")).toEqual(["customer", "id"]);
  });

  it("has an owner path for every customer-scoped type — no rule can be emitted without one", () => {
    for (const type of CUSTOMER_SCOPED_TYPES) {
      expect(ownerPath(type), `${type} has no owner path`).toBeDefined();
    }
  });

  it("gives no owner path for a metadata or unknown type", () => {
    expect(ownerPath("Team")).toBeUndefined();
    expect(ownerPath("Nope")).toBeUndefined();
    expect(ownerPath("constructor")).toBeUndefined();
  });
});

describe("the curated classification agrees with the pinned schema", () => {
  it("classifies only types the artifact actually carries", () => {
    const known = new Set(typeNames());
    for (const type of [...CUSTOMER_SCOPED_TYPES, ...METADATA_TYPES]) {
      expect(known.has(type), `${type} is classified but absent from schema.json`).toBe(
        true,
      );
    }
  });

  it("extracts every classified type — a classified type with no fields is a parse failure", () => {
    for (const type of [...CUSTOMER_SCOPED_TYPES, ...METADATA_TYPES]) {
      expect(knownType(type)).toBe(true);
    }
  });

  it("documents, per metadata type, why it is safe", () => {
    for (const type of METADATA_TYPES) {
      expect(METADATA_SAFETY[type], `${type} has no safety justification`).toBeTruthy();
    }
    expect(Object.keys(METADATA_SAFETY).sort()).toEqual([...METADATA_TYPES].sort());
  });
});

/**
 * The escape M2 closed by path and Task 2 must close by type. These two tables
 * are computed from the artifact and compared to the curated declaration: if a
 * dependency bump adds `Team.somethingIssues`, this test fails until a human
 * has looked at it.
 */
describe("collections of customer-scoped objects under a metadata type", () => {
  function customerCollections(type: string): string[] {
    const found: string[] = [];
    for (const field of fieldNamesOf(type)) {
      const info = fieldInfo(type, field);
      if (info === undefined) continue;
      const direct = info.list && typeClass(info.type) === "customer-scoped";
      const nodes = info.list ? undefined : fieldInfo(info.type, "nodes");
      const viaConnection =
        nodes?.list === true && typeClass(nodes.type) === "customer-scoped";
      if (direct || viaConnection) found.push(field);
    }
    return found.sort();
  }

  function nonNullableSingles(type: string): string[] {
    const found: string[] = [];
    for (const field of fieldNamesOf(type)) {
      const info = fieldInfo(type, field);
      if (info === undefined) continue;
      if (!info.list && !info.nullable && typeClass(info.type) === "customer-scoped") {
        found.push(field);
      }
    }
    return found.sort();
  }

  it("finds exactly the collections the classification declares", () => {
    const computed: Record<string, string[]> = {};
    for (const type of METADATA_OBJECT_TYPES) {
      const hits = customerCollections(type);
      if (hits.length > 0) computed[type] = hits;
    }
    expect(computed).toEqual(asPlain(METADATA_CUSTOMER_COLLECTIONS));
  });

  it("finds exactly the non-nullable single customer-scoped fields the classification declares", () => {
    const computed: Record<string, string[]> = {};
    for (const type of METADATA_TYPES) {
      const hits = nonNullableSingles(type);
      if (hits.length > 0) computed[type] = hits;
    }
    expect(computed).toEqual(asPlain(METADATA_NON_NULLABLE_CUSTOMER_SINGLES));
  });

  it("separates the Relay shells: a connection inherits its parent's reach, it is not an escape", () => {
    const computed = CONNECTION_TYPES.filter(
      (type) => typeClass(fieldInfo(type, "nodes")?.type ?? "") === "customer-scoped",
    );
    expect(computed).toEqual([...CUSTOMER_SCOPED_CONNECTIONS]);
  });

  it("pins `Team.issues` so Task 2 can deny it by type", () => {
    expect(fieldInfo("Team", "issues")).toEqual({
      type: "IssueConnection",
      nullable: false,
      list: false,
    });
    expect(fieldInfo("IssueConnection", "nodes")?.type).toBe("Issue");
    expect(METADATA_CUSTOMER_COLLECTIONS.Team).toEqual(["issues"]);
  });

  it("pins `User.assignedIssues` — the M2 name-based deny becomes a type-based one", () => {
    expect(fieldInfo("User", "assignedIssues")?.type).toBe("IssueConnection");
    expect(METADATA_CUSTOMER_COLLECTIONS.User).toContain("assignedIssues");
  });
});

function fieldNamesOf(type: string): readonly string[] {
  return schemaFieldNames(type);
}

function asPlain(
  table: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(table).map(([key, value]) => [key, [...value]]),
  );
}
