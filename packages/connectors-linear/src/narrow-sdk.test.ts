import { LinearClient } from "@linear/sdk";
import { Kind, parse, print, visit, type ASTNode, type SelectionNode } from "graphql";
import { describe, expect, it } from "vitest";
import { narrowLinear, type LinearNarrowResult } from "./narrow";
import { typeClass } from "./schema/classification";
import { fieldInfo, leafType, unionMembers } from "./schema/schema";

/**
 * The milestone's acceptance criterion (M3): the OFFICIAL `@linear/sdk` typed
 * methods must work under a customer-scoped mission.
 *
 * The documents are not copied here. `LinearClient` posts through
 * `globalThis.fetch`, so stubbing it captures the exact bytes the SDK would
 * send — generated document, generated fragments, generated variables — and a
 * dependency bump changes what this test runs against, which is the point.
 */

const SCOPE = { linearCustomerId: "c_18" };

async function sdkRequest(call: (client: LinearClient) => unknown): Promise<string> {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init: { body?: unknown }) => {
    bodies.push(String(init.body));
    return Promise.resolve(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  try {
    await call(new LinearClient({ apiKey: "not-a-real-key" }));
  } catch {
    // The canned body is not the shape the SDK's models want; the request has
    // already been captured, which is all this test needs.
  }
  globalThis.fetch = original;
  const body = bodies[0];
  if (body === undefined) throw new Error("the SDK sent no request");
  return body;
}

/**
 * The two fields that still block the criterion, removed from the REAL document
 * so the rest of it can be asserted. `Reaction.initiativeUpdate` and
 * `Reaction.projectUpdate` return `InitiativeUpdate` and `ProjectUpdate`, which
 * nobody has classified — deny-by-default applies to the TYPE, so they refuse
 * the whole document. Classifying them is a product call (are a project's status
 * posts customer data?) and it is deliberately NOT made here.
 */
const UNCLASSIFIED_FIELDS: readonly string[] = ["initiativeUpdate", "projectUpdate"];

function withoutUnclassified(body: string): string {
  const payload = JSON.parse(body) as Record<string, unknown>;
  const pruned = visit(parse(String(payload.query)), {
    Field: (node: { name: { value: string } }) =>
      UNCLASSIFIED_FIELDS.includes(node.name.value) ? null : undefined,
  } as never) as ASTNode;
  return JSON.stringify({ ...payload, query: print(pruned) });
}

function forwardedQuery(result: LinearNarrowResult, sent: string): string {
  const payload = JSON.parse(result.body ?? sent) as Record<string, unknown>;
  return String(payload.query);
}

/**
 * Every response path in a document that lands on a customer-scoped object,
 * recomputed from the artifact — independently of the plan it is compared to.
 */
function customerScopedPaths(query: string, root: string, rootType: string): string[] {
  const found: string[] = [];
  const document = parse(query);
  const fragments = new Map(
    document.definitions
      .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d] as const),
  );
  const walk = (
    selections: readonly SelectionNode[],
    type: string,
    path: readonly string[],
  ): void => {
    const members = unionMembers(type);
    for (const selection of selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const definition = fragments.get(selection.name.value);
        if (definition === undefined) throw new Error(`unknown fragment ${selection.name.value}`);
        walk(definition.selectionSet.selections, definition.typeCondition.name.value, path);
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const condition = selection.typeCondition?.name.value ?? type;
        walk(selection.selectionSet.selections, condition, path);
        continue;
      }
      if (members !== undefined) continue;
      const info = fieldInfo(type, selection.name.value);
      if (info === undefined || leafType(info.type)) continue;
      const key = selection.alias?.value ?? selection.name.value;
      const here = info.list ? [...path, key, "*"] : [...path, key];
      if (typeClass(info.type) === "customer-scoped") found.push(here.join("."));
      walk(selection.selectionSet?.selections ?? [], info.type, here);
    }
  };
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const selection of definition.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD || selection.name.value !== root) continue;
      const here = ["data", selection.alias?.value ?? root];
      if (typeClass(rootType) === "customer-scoped") found.push(here.join("."));
      walk(selection.selectionSet?.selections ?? [], rootType, here);
    }
  }
  return found;
}

interface Method {
  name: string;
  call: (client: LinearClient) => unknown;
  root: string;
  rootType: string;
}

const METHODS: Method[] = [
  { name: "linear.issue(id)", call: (c) => c.issue("i1"), root: "issue", rootType: "Issue" },
  {
    name: "linear.issues({first:5})",
    call: (c) => c.issues({ first: 5 }),
    root: "issues",
    rootType: "IssueConnection",
  },
];

describe("the @linear/sdk typed methods under a customer-scoped mission", () => {
  it.each(METHODS)(
    "$name is ALLOWED with a plan covering every customer-scoped path it selects",
    async ({ call, root, rootType }: Method) => {
      const sent = withoutUnclassified(await sdkRequest(call));
      const result = narrowLinear(sent, SCOPE);

      expect(result.reason).toBeUndefined();
      expect(result.decision).toBe("allow");
      const forwarded = forwardedQuery(result, sent);
      // What NARROW proved is what the vendor runs, and it is still a document
      // the vendor can parse — the union's inline fragments survived.
      expect(() => parse(forwarded)).not.toThrow();
      expect(forwarded).toContain("... on ExternalEntityInfoGithubMetadata");

      // Recomputed from the document the SDK SENT, not the one we forward: the
      // forwarded one carries our own discriminator, which is ours to strip and
      // deliberately gets no rule of its own.
      const sentQuery = String((JSON.parse(sent) as Record<string, unknown>).query);
      const paths = (result.filterPlan?.rules ?? []).map((rule) => rule.path.join("."));
      expect([...paths].sort()).toEqual(
        [...customerScopedPaths(sentQuery, root, rootType)].sort(),
      );
      expect(paths.length).toBeGreaterThan(1);
    },
  );

  it.each(METHODS)(
    "$name carries the ownership route on every object the plan guards",
    async ({ call }: Method) => {
      const sent = withoutUnclassified(await sdkRequest(call));
      const result = narrowLinear(sent, SCOPE);

      for (const rule of result.filterPlan?.rules ?? []) {
        expect(rule.expectedOwnerIds).toEqual(["c_18"]);
        expect(rule.ownerMatch).toBe("exact");
        expect(rule.ownerPath.length).toBeGreaterThan(0);
      }
      // Everything the SDK selects on a related issue or comment is a nullable
      // single, so a foreign one is nulled rather than failing the response —
      // except the requested object itself, which has nothing above it to null.
      const nested = (result.filterPlan?.rules ?? []).slice(0, -1);
      expect(nested.every((rule) => rule.nullable || rule.path.at(-1) === "*")).toBe(true);
    },
  );

  /**
   * The union `ExternalEntityInfo.metadata` used to be EXCLUDED by the
   * extractor, and the SDK's `Issue` fragment selects it through
   * `syncedWith { ...ExternalEntityInfo }` — so it alone refused every typed
   * read. It is allowed now because ALL THREE of its members are scalars-only
   * metadata types, which is decidable from the artifact.
   */
  it("no longer refuses the ExternalEntityInfo union", async () => {
    const result = narrowLinear(await sdkRequest((c) => c.issue("i1")), SCOPE);

    expect(result.reason ?? "").not.toContain("ExternalEntityInfo");
    expect(result.reason ?? "").not.toContain("metadata");
  });

  /**
   * The remaining blocker, pinned so it cannot be forgotten and cannot grow.
   * When someone classifies these two types, this test fails — and the two
   * above should then run against the untouched SDK document.
   */
  it("is blocked by exactly two unclassified types, and nothing else", async () => {
    const blockers: string[] = [];
    for (const method of METHODS) {
      const result = narrowLinear(await sdkRequest(method.call), SCOPE);
      expect(result.decision).toBe("deny");
      blockers.push(result.reason ?? "");
    }

    for (const reason of blockers) {
      expect(reason).toMatch(/`Reaction\.(initiativeUpdate|projectUpdate)`/);
      expect(reason).toContain("a type the connector has not classified");
    }
  });
});
