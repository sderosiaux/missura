import type { FilterPlan } from "@missura/core";
import type { NarrowResult } from "./narrow";
import { request } from "./pipeline.fixtures";
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

export function graphqlRequest(first: number): IncomingShape {
  return request({
    method: "POST",
    path: "/graphql",
    body: JSON.stringify({
      query: "query Issues($first: Int!, $after: String) { issues { … } }",
      variables: { first },
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
