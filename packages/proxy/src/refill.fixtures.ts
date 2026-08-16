import type { CursorPosition, CursorStore, FilterPlan } from "@missura/core";
import type { NarrowFn, NarrowResult } from "./narrow";
import { CLAIMS, request } from "./pipeline.fixtures";
import type { IncomingShape } from "./transport";

/**
 * Test-only vendor pages for the pagination REFILL specs. A node whose id
 * starts with `x` belongs to another customer, so "how many survive the
 * filter" is readable straight off the ids a test writes.
 */

export const OWNER = "c_18";

export function node(id: string): Record<string, unknown> {
  return {
    id,
    customer: { id: id.startsWith("x") ? "c_globex" : OWNER },
  };
}

export function page(
  ids: readonly string[],
  hasNextPage: boolean,
  endCursor: string,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    data: {
      issues: {
        nodes: ids.map(node),
        pageInfo: { hasNextPage, endCursor },
        ...extra,
      },
    },
  };
}

/**
 * A vendor that answers a different page per call. `undefined` means the call
 * fails on the wire, which is how a test drives the fail-closed path.
 */
export function serveEach(
  pageAt: (index: number) => unknown,
  headersAt: (index: number) => Record<string, string> = () => ({}),
): () => Promise<Response> {
  let index = -1;
  return (): Promise<Response> => {
    index += 1;
    const body = pageAt(index);
    if (body === undefined) {
      return Promise.reject(new Error("vendor unreachable"));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headersAt(index) },
      }),
    );
  };
}

/** One page of a collection a test drives end to end. */
export interface PageSpec {
  ids: readonly string[];
  endCursor: string;
  hasNextPage: boolean;
}

/**
 * A vendor whose pages are addressed by POSITION — the page it answers is the
 * one the request's own `after` names, so reading the same position twice reads
 * the same objects back. `serveEach` answers by CALL ORDER, which cannot express
 * a walk that resumes into a page it already read.
 *
 * The page size the request asks for is ignored on purpose: these specs fix the
 * collection's page boundaries, and a double that re-cut them per request would
 * be testing its own arithmetic rather than the proxy's.
 */
export function serveWalk(
  specs: readonly PageSpec[],
): (url: string, init: RequestInit) => Promise<Response> {
  return (_url: string, init: RequestInit): Promise<Response> => {
    const sent = typeof init.body === "string" ? init.body : "{}";
    const { variables } = JSON.parse(sent) as {
      variables?: { after?: string };
    };
    const after = variables?.after;
    const index =
      after === undefined
        ? 0
        : specs.findIndex((spec) => spec.endCursor === after) + 1;
    const spec = after !== undefined && index === 0 ? undefined : specs[index];
    if (spec === undefined) {
      return Promise.reject(new Error(`no page at ${String(after)}`));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify(page(spec.ids, spec.hasNextPage, spec.endCursor)),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  };
}

export function plan(requested: number): FilterPlan {
  return {
    rules: [
      {
        path: ["data", "issues", "nodes", "*"],
        type: "Issue",
        ownerPath: ["customer", "id"],
        expectedOwnerIds: [OWNER],
        ownerMatch: "exact",
        injected: ["customer"],
        nullable: false,
      },
    ],
    strip: [],
    pagination: {
      path: ["data", "issues"],
      nodes: "nodes",
      requested,
      cursor: {
        source: "body-path",
        pageInfo: ["pageInfo"],
        cursorPath: ["variables", "after"],
      },
    },
  };
}

export function withPlan(filterPlan: FilterPlan): () => NarrowResult {
  return (): NarrowResult => ({ decision: "allow", filterPlan });
}

/**
 * A connector whose plan mirrors the page size the request asked for, the way a
 * real NARROW reads `first` off the document it is narrowing. `withPlan` fixes
 * one size for every call, which cannot express an agent that changes its mind
 * between pages.
 */
export const requestedPlan: NarrowFn = (req) => {
  let first: unknown;
  try {
    ({
      variables: { first },
    } = JSON.parse(req.body) as { variables: { first: unknown } });
  } catch {
    first = undefined;
  }
  return {
    decision: "allow",
    filterPlan: plan(typeof first === "number" ? first : 1),
  };
};

/** The agent's own request; `after` is a missura handle, never a position. */
export function graphqlRequest(first: number, after?: string): IncomingShape {
  return request({
    method: "POST",
    path: "/graphql",
    body: JSON.stringify({
      query: "query Issues($first: Int!, $after: String) { issues { … } }",
      variables: { first, ...(after === undefined ? {} : { after }) },
    }),
  });
}

/** The JSON body one upstream call actually carried. */
export function sentBody(call: { init: RequestInit } | undefined): unknown {
  const body = call?.init.body;
  if (typeof body !== "string") throw new Error("that call carried no body");
  return JSON.parse(body);
}

export interface Connection {
  nodes: { id: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string };
  totalCount?: number;
}

export function connection(body: string | Uint8Array): Connection {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  return (JSON.parse(text) as { data: { issues: Connection } }).data.issues;
}

/**
 * The answer with the cursor taken out. Cursors are missura handles now, so two
 * runs of the same request never share one — comparing whole bodies would
 * compare the randomness instead of the objects.
 */
export function withoutCursor(body: string | Uint8Array): string {
  const conn = connection(body);
  return JSON.stringify({
    nodes: conn.nodes,
    hasNextPage: conn.pageInfo.hasNextPage,
    totalCount: conn.totalCount,
  });
}

/** The handle an answer hands back — what the agent sends as its next `after`. */
export function cursorOf(body: string | Uint8Array): string {
  return connection(body).pageInfo.endCursor;
}

/**
 * The answer's raw bytes with the handle blanked out.
 *
 * A handle is a random value, so searching the whole body for a vendor string
 * hits the randomness now and then — `not.toContain("412")` fails on the run
 * where the UUID happens to spell it. An assertion about what we WROTE has to
 * look past what we rolled.
 */
export function withoutHandle(body: string | Uint8Array): string {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  return text.replaceAll(cursorOf(body), "«handle»");
}

/** The object ids an answer carries, in order. */
export function idsOf(body: string | Uint8Array): string[] {
  return connection(body).nodes.map((node) => node.id);
}

/** What a handed-back cursor stands for on our side, per the harness store. */
export function positionOf(
  h: { deps: { cursors: CursorStore } },
  body: string | Uint8Array,
): CursorPosition | undefined {
  return h.deps.cursors.resolve(CLAIMS.id, cursorOf(body));
}

/** The vendor position a handed-back cursor stands for. */
export function behindCursor(
  h: { deps: { cursors: CursorStore } },
  body: string | Uint8Array,
): string | undefined {
  return positionOf(h, body)?.vendorCursor;
}
