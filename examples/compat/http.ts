import { OperationTypeNode, parse } from "graphql";
import type { Exchange } from "./classify";

/**
 * The one door to the network, and the place the read-only promise is KEPT
 * rather than described.
 *
 * This suite runs against a human's real Linear workspace, real GitHub account
 * and real Zendesk tenant. "Read-only" as a comment is worth nothing: the
 * assertion is here, it throws, and every call in both halves goes through it.
 *
 *   - the HTTP method must be GET, HEAD or OPTIONS — no exceptions;
 *   - the single exception is a POST to a GraphQL endpoint, and only after the
 *     document has been PARSED and every operation in it proven to be a
 *     `query`. A `mutation` or a `subscription` throws before the socket opens.
 *
 * Every call announces itself on stderr first, so the human watching can stop
 * a run before it does something they did not expect.
 */

export class WriteAttemptError extends Error {}

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Parses the document and refuses anything that is not a query. */
export function assertQueryOnly(document: string): void {
  let parsed;
  try {
    parsed = parse(document);
  } catch (err) {
    throw new WriteAttemptError(
      `refusing to send a GraphQL document this suite cannot parse, so it cannot prove it is a read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  for (const definition of parsed.definitions) {
    if (definition.kind !== "OperationDefinition") continue;
    if (definition.operation !== OperationTypeNode.QUERY) {
      throw new WriteAttemptError(
        `refusing to send a GraphQL ${definition.operation}: this suite is read-only`,
      );
    }
  }
}

export function assertReadOnly(
  method: string,
  url: string,
  body: string | undefined,
): void {
  const verb = method.toUpperCase();
  if (READ_ONLY_METHODS.has(verb)) return;
  if (verb !== "POST" || !new URL(url).pathname.endsWith("/graphql")) {
    throw new WriteAttemptError(
      `refusing to send ${verb} ${url}: this suite is read-only`,
    );
  }
  const parsed: unknown = JSON.parse(body ?? "{}");
  const query =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).query
      : undefined;
  if (typeof query !== "string") {
    throw new WriteAttemptError(
      "refusing to POST a GraphQL body with no readable `query`: it cannot be proven to be a read",
    );
  }
  assertQueryOnly(query);
}

export interface CallInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Printed before the call, so a human can see what is about to happen. */
  announce: string;
}

/** Header names whose value must never be printed or recorded. */
const SECRET_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

function safeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (!SECRET_HEADERS.has(key)) out[key] = value;
  });
  return out;
}

/**
 * A pause between vendor calls. Conservative on purpose: the human's Zendesk
 * search endpoint is the tightest budget in the run, and a suite that trips a
 * rate limit on someone's production tenant has cost them something to prove
 * nothing.
 */
export async function pace(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function call(input: CallInput): Promise<Exchange> {
  assertReadOnly(input.method, input.url, input.body);
  process.stderr.write(`  → ${input.announce}\n`);
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  return {
    issued: true,
    status: response.status,
    headers: safeHeaders(response.headers),
    body: await response.text(),
  };
}

/** The call this suite decided NOT to make, and why. */
export function notIssued(): Exchange {
  return { issued: false, status: 0, headers: {}, body: "" };
}
