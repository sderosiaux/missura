import { Kind, parse, type SelectionNode } from "graphql";
import { describe, expect, it } from "vitest";
import { narrowLinear, type LinearNarrowResult } from "./narrow";

const SCOPE = { linearCustomerId: "c_18" };
const NO_SCOPE = {};

function request(query: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ query, ...extra });
}

/**
 * The traversal contract, written out independently of the implementation:
 * every field carrying a selection set in the forwarded document must sit on
 * one of these paths. Anything else is a cross-customer read waiting to happen.
 */
const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "issues",
  "issues.nodes",
  "issues.nodes.customer",
  "issues.nodes.assignee",
  "issues.nodes.creator",
  "issues.nodes.state",
  "issues.nodes.labels",
  "issues.nodes.labels.nodes",
  "issues.nodes.comments",
  "issues.nodes.comments.nodes",
  "issues.nodes.comments.nodes.user",
  "issues.pageInfo",
  "issue",
  "issue.customer",
  "issue.assignee",
  "issue.creator",
  "issue.state",
  "issue.labels",
  "issue.labels.nodes",
  "issue.comments",
  "issue.comments.nodes",
  "issue.comments.nodes.user",
  "issue.pageInfo",
  "customer",
  "viewer",
]);

function collect(
  selections: readonly SelectionNode[],
  path: readonly string[],
  offending: string[],
): void {
  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) {
      // An unresolved fragment in the forwarded document is itself an escape:
      // its paths were never proven.
      offending.push([...path, `<${selection.kind}>`].join("."));
      continue;
    }
    if (selection.selectionSet === undefined) continue;
    const here = [...path, selection.name.value];
    const key = here.join(".");
    if (!ALLOWED_PATHS.has(key)) offending.push(key);
    collect(selection.selectionSet.selections, here, offending);
  }
}

/** Every path in the forwarded document that the contract does not allow. */
function offendingPaths(query: string): string[] {
  const offending: string[] = [];
  for (const definition of parse(query).definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      offending.push(`<${definition.kind}>`);
      continue;
    }
    collect(definition.selectionSet.selections, [], offending);
  }
  return offending;
}

function forwarded(result: LinearNarrowResult, original: string): string {
  if (result.body === undefined) return original;
  const payload = JSON.parse(result.body) as Record<string, unknown>;
  return String(payload.query);
}

interface Hostile {
  name: string;
  query: string;
  scope: { linearCustomerId?: string };
}

const HOSTILE: Hostile[] = [
  {
    name: "issues > nodes > team re-expands the whole workspace",
    query:
      'query { issues(first: 1) { nodes { team { issues(first: 250) { nodes { id title customer { id } } } } } } }',
    scope: SCOPE,
  },
  {
    name: "issue(id) > team smuggles the payload past the post-check",
    query:
      'query { issue(id: "i1") { id team { issues(first: 250) { nodes { id title customer { id } } } } } }',
    scope: SCOPE,
  },
  {
    name: "viewer > assignedIssues dumps every issue assigned to the token",
    query:
      "query { viewer { assignedIssues(first: 250) { nodes { id title description } } } }",
    scope: SCOPE,
  },
  {
    name: "viewer > teams > issues > customer walks the org",
    query:
      "query { viewer { teams { nodes { issues { nodes { customer { id } } } } } } }",
    scope: SCOPE,
  },
  {
    name: "viewer > assignedIssues under a mission with no linear scope",
    query: "query { viewer { assignedIssues(first: 250) { nodes { id } } } }",
    scope: NO_SCOPE,
  },
  {
    name: "customer > projects leaves the customer object",
    query: 'query { customer(id: "c_18") { id projects { nodes { id name } } } }',
    scope: SCOPE,
  },
  {
    name: "issues > nodes > comments > nodes > issue climbs back up",
    query:
      "query { issues { nodes { comments { nodes { body issue { id title customer { id } } } } } } }",
    scope: SCOPE,
  },
  {
    name: "aliased nested escape hides the field name",
    query:
      "query { issues { nodes { t: team { issues(first: 250) { nodes { id customer { id } } } } } } }",
    scope: SCOPE,
  },
  {
    name: "named fragment smuggles the team traversal",
    query:
      "query { issues { nodes { ...Esc } } } fragment Esc on Issue { id team { issues(first: 250) { nodes { id customer { id } } } } }",
    scope: SCOPE,
  },
  {
    name: "inline fragment smuggles the team traversal",
    query:
      'query { issue(id: "i1") { id ... on Issue { team { issues { nodes { id customer { id } } } } } } }',
    scope: SCOPE,
  },
  {
    name: "@include(if: true) guards the nested connection",
    query:
      "query { issues { nodes { team @include(if: true) { issues { nodes { id } } } } } }",
    scope: SCOPE,
  },
  {
    name: "a prototype key is not a traversal",
    query: "query { issues { nodes { constructor { id } } } }",
    scope: SCOPE,
  },
  {
    name: "issue > project is not provably customer-bound",
    query: 'query { issue(id: "i1") { id project { id name } } }',
    scope: SCOPE,
  },
  {
    name: "issue > customer > projects escapes through the proven relation",
    query: 'query { issue(id: "i1") { id customer { id projects { nodes { id } } } } }',
    scope: SCOPE,
  },
];

describe("narrowLinear — document isolation (adversarial)", () => {
  it.each(HOSTILE)(
    "denies or strips: $name",
    ({ query, scope }: Hostile) => {
      const result = narrowLinear(request(query), scope);
      if (result.decision === "deny") {
        expect(result.reason).toBeTypeOf("string");
        expect(result.body).toBeUndefined();
        return;
      }
      expect(offendingPaths(forwarded(result, query))).toEqual([]);
    },
  );

  it.each([
    ["team", HOSTILE[0]?.query ?? ""],
    ["team", HOSTILE[1]?.query ?? ""],
    ["assignedIssues", HOSTILE[2]?.query ?? ""],
    ["teams", HOSTILE[3]?.query ?? ""],
    ["projects", HOSTILE[5]?.query ?? ""],
  ])("names the offending field `%s` in the reason", (field, query) => {
    const result = narrowLinear(request(query), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain(field);
  });
});

describe("narrowLinear — legitimate traversals still pass", () => {
  it("allows the full allowlisted issue shape", () => {
    const result = narrowLinear(
      request(
        "query { issues(first: 10) { nodes { id title customer { id name } assignee { id } " +
          "creator { id } state { name } labels { nodes { name } } " +
          "comments { nodes { body user { name } } } } pageInfo { hasNextPage } } }",
      ),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(offendingPaths(forwarded(result, ""))).toEqual([]);
  });

  it("allows an allowlisted issue(id) traversal", () => {
    const result = narrowLinear(
      request('query { issue(id: "i1") { id title comments { nodes { body user { name } } } } }'),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(offendingPaths(forwarded(result, ""))).toEqual([]);
  });

  it("resolves a deep named fragment instead of refusing it", () => {
    const result = narrowLinear(
      request(
        "query { issues { nodes { ...Safe } } } fragment Safe on Issue { id title state { name } }",
      ),
      SCOPE,
    );
    expect(result.decision).toBe("allow");
    expect(offendingPaths(forwarded(result, ""))).toEqual([]);
  });

  it("denies a fragment spread it cannot resolve", () => {
    const result = narrowLinear(request("query { issues { nodes { ...Missing } } }"), SCOPE);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Missing");
  });
});

describe("narrowLinear — extensions never reach the vendor", () => {
  const query = "query { viewer { id } }";

  it("denies a persisted-query hash", () => {
    const result = narrowLinear(
      request(query, {
        extensions: { persistedQuery: { version: 1, sha256Hash: "deadbeef" } },
      }),
      SCOPE,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("persisted query not supported");
  });

  it("strips a benign extensions block from the forwarded body", () => {
    const result = narrowLinear(request(query, { extensions: { tracing: true } }), SCOPE);
    expect(result.decision).toBe("allow");
    const payload = JSON.parse(result.body ?? "") as Record<string, unknown>;
    expect(payload.extensions).toBeUndefined();
    expect("extensions" in payload).toBe(false);
    expect(payload.query).toBeTypeOf("string");
  });

  it("strips extensions from a rewritten issues document too", () => {
    const result = narrowLinear(
      request("query { issues { nodes { id } } }", { extensions: { foo: 1 } }),
      SCOPE,
    );
    const payload = JSON.parse(result.body ?? "") as Record<string, unknown>;
    expect("extensions" in payload).toBe(false);
    expect(String(payload.query)).toContain("c_18");
  });
});
