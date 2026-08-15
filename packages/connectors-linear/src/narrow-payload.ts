import { isRecord } from "./narrow-ast";

const EXTENSIONS = "extensions";
const PERSISTED = "persistedQuery";

export interface Payload {
  record: Record<string, unknown>;
  query: string;
  variables?: Record<string, unknown>;
  /** True when the request carried `extensions` — it never reaches the vendor. */
  carriesExtensions: boolean;
}

/**
 * A persisted-query hash asks the vendor to run a document it already has
 * cached — one NARROW never saw and cannot narrow. The `query` in the body
 * would be decoration.
 */
function persistedQuery(extensions: unknown): boolean {
  return isRecord(extensions) && Object.hasOwn(extensions, PERSISTED);
}

/** Returns the payload, or the reason it cannot be read (which denies). */
export function readPayload(body: string): Payload | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "request body is not JSON — expected a GraphQL POST payload";
  }
  if (!isRecord(parsed)) {
    return "request body is not JSON — expected a GraphQL POST payload";
  }
  const query: unknown = parsed.query;
  if (typeof query !== "string") return "request body has no string `query` field";
  const carriesExtensions = Object.hasOwn(parsed, EXTENSIONS);
  if (carriesExtensions && persistedQuery(parsed[EXTENSIONS])) {
    return "persisted query not supported";
  }
  const variables: unknown = parsed.variables;
  if (variables === undefined || variables === null) {
    return { record: parsed, query, carriesExtensions };
  }
  if (!isRecord(variables)) return "request `variables` is not an object";
  return { record: parsed, query, variables, carriesExtensions };
}

/**
 * The body handed to the vendor. `extensions` is dropped whatever it holds:
 * it is the one field of the payload that can change which document runs, and
 * nothing downstream of NARROW re-reads it.
 */
export function forwardRecord(
  payload: Payload,
  query: string,
  variables: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const kept = Object.entries(payload.record).filter(([key]) => key !== EXTENSIONS);
  const next: Record<string, unknown> = { ...Object.fromEntries(kept), query };
  if (variables !== undefined) next.variables = variables;
  return next;
}
