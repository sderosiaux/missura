import type { MissionClaims } from "@missura/core";

/**
 * What NARROW had to add to the query to make the ownership check possible,
 * and therefore what has to come back out of the response:
 *   - `none`     the agent asked for all of it; nothing is ours to remove.
 *   - `relation` the whole `customer { id }` is ours.
 *   - `id`       the agent asked for the relation, we widened it with `id`.
 * A boolean could not tell the last two apart, and stripping the relation in
 * the `id` case would take away a field the agent did ask for.
 */
export type InjectedSelection = "none" | "relation" | "id";

/**
 * Response-side ownership check registered by a connector's NARROW. The
 * pipeline knows nothing about GraphQL: it looks `path` up in the parsed JSON
 * body, compares the value against `expectedCustomerId`, and removes whatever
 * NARROW added so the agent sees exactly the shape it asked for.
 */
export interface NarrowPostCheck {
  /** e.g. `["data","issue","customer","id"]`. */
  path: string[];
  expectedCustomerId: string;
  injectedSelection: InjectedSelection;
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
  if (check.injectedSelection === "none") return { ok: true, body };
  // We added it to make the check possible — take back exactly that much.
  const owned = subject[relation];
  const rest =
    check.injectedSelection === "relation"
      ? without(subject, relation)
      : { ...subject, [relation]: isRecord(owned) ? without(owned, field) : owned };
  const stripped = replace(parsed, check.path.slice(0, -2), rest);
  return { ok: true, body: JSON.stringify(stripped) };
}

function without(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([k]) => k !== key));
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
