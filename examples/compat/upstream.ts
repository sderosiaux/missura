/**
 * What the proxy actually sent the vendor, recorded rather than claimed.
 *
 * `createServers` takes a `fetchImpl`, which is the only place every upstream
 * call of every connection passes through. Wrapping it does three things at
 * once, and all three matter for a suite pointed at a production tenant:
 *
 *   1. the read-only assertion covers the PROXY's calls too, not just the ones
 *      this file's own half issues — a connector that started making a write
 *      would throw here, before the socket;
 *   2. every call announces itself on stderr, so the human watching sees the
 *      proxied half exactly as they see the direct half;
 *   3. the rewritten target is OBSERVED. Half B's `compatible_with_rewrite`
 *      claim would be worth nothing read off the connector's own source.
 */
import { Kind, parse as parseGraphql } from "graphql";
import { assertReadOnly, WriteAttemptError, type CallInput } from "./http";

/**
 * A GraphQL request's shape, compact enough to sit in a report and specific
 * enough that a REWRITE changes it.
 *
 * Linear's narrowing happens in the BODY — a filter ANDed in, an ownership
 * selection added — so `METHOD /graphql` is identical before and after and
 * would report a rewritten document as an untouched one. The root field names
 * are the agent's own and carry nothing of the vendor's; the character count is
 * what moves when the document is rewritten.
 */
export function graphqlSignature(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const query = (parsed as Record<string, unknown>).query;
  if (typeof query !== "string") return undefined;
  const roots: string[] = [];
  try {
    for (const definition of parseGraphql(query).definitions) {
      if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
      for (const selection of definition.selectionSet.selections) {
        if (selection.kind === Kind.FIELD) roots.push(selection.name.value);
      }
    }
  } catch {
    return `graphql(unparseable, ${String(query.length)} chars)`;
  }
  return `graphql(${roots.join(",")}, ${String(query.length)} chars)`;
}

/**
 * `METHOD /path?query` — origin dropped, so no subdomain travels into a report,
 * plus the GraphQL signature when there is a document to describe.
 */
export function targetOf(
  method: string,
  url: string,
  body?: string,
): string {
  const parsed = new URL(url);
  const signature = graphqlSignature(body);
  const target = `${method.toUpperCase()} ${parsed.pathname}${parsed.search}`;
  return signature === undefined ? target : `${target} ${signature}`;
}

export interface Recorder {
  fetchImpl: typeof fetch;
  /** The calls recorded since the last `take`, oldest first. Resets. */
  take(): string[];
}

function bodyOf(init: RequestInit | undefined): string | undefined {
  const body = init?.body;
  return typeof body === "string" ? body : undefined;
}

export function createRecorder(announce: (line: string) => void): Recorder {
  let calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    // The proxy always calls with a string url (`forward.ts` builds one), so a
    // `Request` or a `URL` reaching here is a caller this suite has never seen
    // and must not guess the target of.
    if (typeof input !== "string") {
      throw new WriteAttemptError(
        "refusing a request whose target is not a plain url: this suite cannot prove what it would call",
      );
    }
    const url = input;
    const method = init?.method ?? "GET";
    const body = bodyOf(init);
    assertReadOnly(method, url, body);
    calls.push(targetOf(method, url, body));
    // The FULL url on stderr — a human stopping a run needs to see the host.
    // Only the recorded form drops the origin, because that one reaches a file.
    announce(`missura → vendor  ${method.toUpperCase()} ${url}`);
    return fetch(url, init);
  };
  return {
    fetchImpl,
    take: (): string[] => {
      const taken = calls;
      calls = [];
      return taken;
    },
  };
}

/** The pathname inside a recorded target: after the verb, before query or signature. */
function pathOf(target: string): string {
  const space = target.indexOf(" ");
  const rest = space < 0 ? target : target.slice(space + 1);
  const end = rest.search(/[?\s]/);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Which of several recorded calls is the one the agent's request became.
 *
 * One agent request can cost the proxy more than one vendor call: a PARENT
 * PROOF probes the parent first (`GET /api/v2/tickets/{id}` before
 * `…/comments`), and REFILL re-issues the query to repair a page filtering made
 * short. So the first call is not always the operation's own, and the last one
 * is not either.
 *
 * The rule is structural rather than a table of known probes: a parent proof
 * always asks about a PARENT, so its path is a proper prefix of the child's.
 * The operation's own call is therefore the first one no later call extends —
 * and with a single call, which is the ordinary case, it is that call.
 */
export function operationCall(calls: readonly string[]): string | undefined {
  for (let i = 0; i < calls.length; i += 1) {
    const current = calls[i];
    if (current === undefined) continue;
    const prefix = `${pathOf(current)}/`;
    const extended = calls
      .slice(i + 1)
      .some((later) => pathOf(later).startsWith(prefix));
    if (!extended) return current;
  }
  return undefined;
}

/**
 * A call this suite is about to make itself. The announcement carries the whole
 * url, host included: it is what a human reads before deciding to stop the run.
 */
export function announced(
  label: string,
  input: Omit<CallInput, "announce">,
): CallInput {
  return {
    ...input,
    announce: `${label}  ${input.method.toUpperCase()} ${input.url}`,
  };
}
