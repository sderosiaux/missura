import type { MissionClaims } from "@missura/core";

/**
 * Response-side ownership check registered by a connector's NARROW. The
 * pipeline knows nothing about GraphQL: it looks `path` up in the parsed JSON
 * body, compares the value against `expectedCustomerId`, and — if NARROW had
 * to add the relation to the query to make the check possible — removes it
 * again so the agent sees exactly the shape it asked for.
 */
export interface NarrowPostCheck {
  /** e.g. `["data","issue","customer","id"]`. */
  path: string[];
  expectedCustomerId: string;
  injectedSelection: boolean;
}

export interface NarrowResult {
  decision: "allow" | "deny";
  /** Rewritten request target (query qualifiers forced in, for instance). */
  path?: string;
  /** Rewritten request body (a narrowed GraphQL document/variables). */
  body?: string;
  /** `github404` answers with GitHub's own not-found shape: no enumeration. */
  denyShape?: "github404";
  reason?: string;
  postCheck?: NarrowPostCheck;
}

export type NarrowFn = (
  req: { method: string; path: string; body: string },
  claims: MissionClaims,
) => NarrowResult;

/**
 * The seam's neutral element: used until a connector installs its own NARROW,
 * and by the connection whose vendor a given mission does not narrow. It adds
 * nothing — the catalog and the mission checks still decide.
 */
export const passThroughNarrow: NarrowFn = () => ({ decision: "allow" });

/** GitHub's own not-found body, byte for byte. */
export const GITHUB_NOT_FOUND_BODY = '{"message":"Not Found"}';

/**
 * A GraphQL not-found: Linear answers 200 with an `errors` array, so an object
 * outside the mission has to look exactly like an object that does not exist.
 * A different status would itself be the leak the check exists to prevent.
 */
export const NOT_FOUND_GRAPHQL_BODY =
  '{"errors":[{"message":"issue not found"}]}';

export const OUT_OF_SCOPE_REASON = "out-of-scope object";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookup(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Verifies the object the vendor returned belongs to the mission. Anything the
 * check cannot prove — unparseable body, missing relation, wrong owner — is a
 * refusal: an unverifiable object is treated exactly like a foreign one.
 */
export function applyPostCheck(
  check: NarrowPostCheck,
  body: string,
): { ok: boolean; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, body: NOT_FOUND_GRAPHQL_BODY };
  }
  const relation = check.path[check.path.length - 2];
  const field = check.path[check.path.length - 1];
  if (relation === undefined || field === undefined) {
    return { ok: false, body: NOT_FOUND_GRAPHQL_BODY };
  }
  const subject = lookup(parsed, check.path.slice(0, -2));
  // The vendor returned no object at all: nothing to own, nothing to leak.
  if (subject === null || subject === undefined) return { ok: true, body };
  if (!isRecord(subject)) return { ok: false, body: NOT_FOUND_GRAPHQL_BODY };

  const owner = lookup(subject, [relation, field]);
  if (owner !== check.expectedCustomerId) {
    return { ok: false, body: NOT_FOUND_GRAPHQL_BODY };
  }
  if (!check.injectedSelection) return { ok: true, body };
  // We added the relation to make the check possible — take it back out.
  const rest = Object.fromEntries(
    Object.entries(subject).filter(([key]) => key !== relation),
  );
  const stripped = replace(parsed, check.path.slice(0, -2), rest);
  return { ok: true, body: JSON.stringify(stripped) };
}

/** Rebuilds `root` with `value` at `path` — no mutation of the parsed body. */
function replace(
  root: unknown,
  path: readonly string[],
  value: unknown,
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (!isRecord(root)) return root;
  return { ...root, [head]: replace(root[head], rest, value) };
}
