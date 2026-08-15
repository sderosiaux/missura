import { describe, expect, it } from "vitest";
import {
  parseSdkDeclarations,
  type SdkSchema,
} from "./sdk-declarations";
import { buildSchemaDocument, serializeSchema, readCommittedSchema } from "./extract";

/**
 * A hand-written stand-in for the SDK's generated declarations. Every shape the
 * real `index.d.mts` uses is present exactly once, so a parser change is caught
 * here before it is caught by the (much larger) drift assertion below.
 */
const FIXTURE = `
/** A thing. */
declare class Widget extends Request {
  private _owner?;
  private _team;
  constructor(request: LinearRequest, data: WidgetFragment);
  /** The unique identifier. */
  id: string;
  /** Nullable scalar. */
  description?: string | null;
  /** Non-null list of scalars. */
  labelIds: string[];
  /** Nullable list of embedded objects. */
  parts?: Part[] | null;
  /** Non-null embedded object. */
  badge: Badge;
  /** A custom scalar. */
  payload: Scalars["JSONObject"];
  /** A shape the parser cannot name. */
  templateData: Record<string, unknown>;
  /** Nullable relation. */
  get owner(): LinearFetch<Part> | undefined;
  /** SDK-synthesized companion of the relation above. */
  get ownerId(): string | undefined;
  /** Non-null relation. */
  get team(): LinearFetch<Badge> | undefined;
  /** Root query in disguise: no backing private field. */
  get organization(): LinearFetch<Badge>;
  /** Connection field. */
  widgets(variables?: Omit<Widget_WidgetsQueryVariables, "id">): LinearFetch<WidgetConnection>;
  /** Mutation. */
  update(input: WidgetUpdateInput): LinearFetch<WidgetPayload>;
  /** Mutation with query-shaped variables. */
  archive(variables?: Omit<ArchiveWidgetMutationVariables, "id">): LinearFetch<WidgetArchivePayload>;
}
declare class Part extends Request {
  constructor(request: LinearRequest, data: PartFragment);
  id: string;
}
declare class Badge extends Request {
  constructor(request: LinearRequest, data: BadgeFragment);
  id: string;
}
declare class WidgetConnection extends Connection<Widget> {
  constructor(request: LinearRequest, fetch: (c?: LinearConnectionVariables) => LinearFetch<LinearConnection<Widget> | undefined>, data: WidgetConnectionFragment);
}
declare class Unwanted extends Request {
  constructor(request: LinearRequest, data: UnwantedFragment);
  secret: string;
}
`;

function fixture(): SdkSchema {
  return parseSdkDeclarations(FIXTURE, ["Widget", "Part", "Badge", "WidgetConnection"]);
}

describe("sdk declaration parser — fields it maps", () => {
  const schema = fixture();
  const widget = schema.types.Widget;

  it("maps a non-null scalar property", () => {
    expect(widget?.fields.id).toEqual({ type: "string", nullable: false, list: false });
  });

  it("maps an optional `T | null` property as nullable", () => {
    expect(widget?.fields.description).toEqual({
      type: "string",
      nullable: true,
      list: false,
    });
  });

  it("maps a list property and a nullable list property", () => {
    expect(widget?.fields.labelIds).toEqual({
      type: "string",
      nullable: false,
      list: true,
    });
    expect(widget?.fields.parts).toEqual({ type: "Part", nullable: true, list: true });
  });

  it("maps an embedded object property", () => {
    expect(widget?.fields.badge).toEqual({ type: "Badge", nullable: false, list: false });
  });

  it("unwraps a custom scalar to its name", () => {
    expect(widget?.fields.payload).toEqual({
      type: "JSONObject",
      nullable: false,
      list: false,
    });
  });

  it("takes relation nullability from the private `_relation?` field, not the getter", () => {
    // Both getters return `LinearFetch<T> | undefined`; only `_owner` is
    // optional, so only `owner` is a nullable GraphQL field.
    expect(widget?.fields.owner).toEqual({ type: "Part", nullable: true, list: false });
    expect(widget?.fields.team).toEqual({ type: "Badge", nullable: false, list: false });
  });

  it("maps a connection method to its connection type", () => {
    expect(widget?.fields.widgets).toEqual({
      type: "WidgetConnection",
      nullable: false,
      list: false,
    });
  });

  it("synthesizes `nodes` and `pageInfo` for a class extending Connection<T>", () => {
    expect(schema.types.WidgetConnection?.fields).toEqual({
      nodes: { type: "Widget", nullable: false, list: true },
      pageInfo: { type: "PageInfo", nullable: false, list: false },
    });
  });
});

describe("sdk declaration parser — what it refuses to map", () => {
  const schema = fixture();
  const widget = schema.types.Widget;

  it("drops the SDK-synthesized `<relation>Id` getter", () => {
    // `ownerId` is `this._owner?.id` in the SDK: it is derived from the
    // `owner { id }` selection, not a vendor field. Keeping it would let an
    // agent select a field the vendor rejects.
    expect(widget?.fields.ownerId).toBeUndefined();
    expect(widget?.excluded.ownerId).toBe("synthesized-id-getter");
  });

  it("drops a getter with no backing private field", () => {
    expect(widget?.fields.organization).toBeUndefined();
    expect(widget?.excluded.organization).toBe("unbacked-getter");
  });

  it("drops a property whose type it cannot name", () => {
    expect(widget?.fields.templateData).toBeUndefined();
    expect(widget?.excluded.templateData).toBe("unmapped-type");
  });

  it("drops mutations, including one with query-shaped variables", () => {
    expect(widget?.fields.update).toBeUndefined();
    expect(widget?.fields.archive).toBeUndefined();
    expect(widget?.excluded.update).toBe("non-query-method");
    expect(widget?.excluded.archive).toBe("non-query-method");
  });

  it("extracts only the seeded types — anything else stays unknown", () => {
    expect(schema.types.Unwanted).toBeUndefined();
  });

  it("records every leaf type it referenced, so a leaf is known and walkable-into never", () => {
    expect(schema.leaves).toContain("string");
    expect(schema.leaves).toContain("JSONObject");
  });
});

describe("extraction is deterministic and the committed artifact is current", () => {
  it("serializes with stable key ordering, twice in a row", () => {
    const once = serializeSchema(buildSchemaDocument());
    const twice = serializeSchema(buildSchemaDocument());
    expect(once).toBe(twice);
  });

  it("orders type keys and field keys alphabetically", () => {
    const document = buildSchemaDocument();
    const typeNames = Object.keys(document.types);
    expect(typeNames).toEqual([...typeNames].sort());
    for (const type of Object.values(document.types)) {
      const fieldNames = Object.keys(type.fields);
      expect(fieldNames).toEqual([...fieldNames].sort());
    }
  });

  it("matches the committed schema.json — a dependency bump must be re-reviewed", () => {
    expect(readCommittedSchema()).toBe(serializeSchema(buildSchemaDocument()));
  });

  it("pins the SDK version the artifact was extracted from", () => {
    expect(buildSchemaDocument().sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
