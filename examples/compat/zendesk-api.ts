import type { Exchange } from "./classify";
import { zendeskAuthHeader, zendeskBase, type ZendeskCredential } from "./harness";
import { call, pace } from "./http";
import { announced } from "./upstream";

/**
 * The Zendesk door, and the readers that turn an answer into EVIDENCE rather
 * than into a copy of somebody's helpdesk.
 *
 * This suite runs against a real support tenant and its report gets committed,
 * so no reader here returns a subject, a name, an email or a body. What they
 * return is: how many objects came back RELATIVE to another call, which
 * top-level keys a body carried, and which pagination style answered. Those are
 * facts about the API. The rest is the customer's.
 */

/** Small on purpose: every list call in this suite asks for one or two objects. */
export const TINY_PAGE = 1;
/**
 * Zendesk's search endpoint is the tightest budget on the account, and it is
 * shared with whatever else the tenant is running. Slower than necessary.
 */
const PACE_MS = 700;

export function zendeskUrl(credential: ZendeskCredential, path: string): string {
  return `${zendeskBase(credential)}${path}`;
}

export async function zendeskCall(
  credential: ZendeskCredential,
  label: string,
  path: string,
): Promise<Exchange> {
  await pace(PACE_MS);
  return call(
    announced(label, {
      method: "GET",
      url: zendeskUrl(credential, path),
      headers: {
        authorization: zendeskAuthHeader(credential),
        accept: "application/json",
      },
    }),
  );
}

/**
 * The same call with a credential that is not one. Used exactly once, to see
 * what a 401 looks like — the only fact about a refusal no valid credential can
 * produce. The string below is a literal, never a real token truncated.
 */
export async function zendeskUnauthenticatedCall(
  credential: ZendeskCredential,
  label: string,
  path: string,
): Promise<Exchange> {
  await pace(PACE_MS);
  const pair = "compat-suite@example.invalid/token:not-a-token";
  return call(
    announced(label, {
      method: "GET",
      url: zendeskUrl(credential, path),
      headers: {
        authorization: `Basic ${Buffer.from(pair, "utf8").toString("base64")}`,
        accept: "application/json",
      },
    }),
  );
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A body's top-level key names, sorted. The SHAPE, never the values. */
export function bodyKeys(body: string): string[] {
  const parsed = parse(body);
  return isRecord(parsed) ? Object.keys(parsed).sort() : [];
}

/** How many elements the named root array held, or `undefined` if there is none. */
export function listLength(body: string, key: string): number | undefined {
  const parsed = parse(body);
  if (!isRecord(parsed)) return undefined;
  const list = parsed[key];
  return Array.isArray(list) ? list.length : undefined;
}

/** Zendesk's own total for a search, which is a count and not a result. */
export function searchCount(body: string): number | undefined {
  const parsed = parse(body);
  if (!isRecord(parsed)) return undefined;
  return typeof parsed.count === "number" ? parsed.count : undefined;
}

/** The id of the first element of a root array — used to aim later calls. */
export function firstId(body: string, key: string): string | undefined {
  const parsed = parse(body);
  if (!isRecord(parsed)) return undefined;
  const list = parsed[key];
  if (!Array.isArray(list)) return undefined;
  const first: unknown = list[0];
  if (!isRecord(first) || typeof first.id !== "number") return undefined;
  return String(first.id);
}

/** A numeric field of the first element, same use, same restraint. */
export function firstNumber(
  body: string,
  key: string,
  field: string,
): string | undefined {
  const parsed = parse(body);
  if (!isRecord(parsed)) return undefined;
  const list = parsed[key];
  if (!Array.isArray(list)) return undefined;
  const first: unknown = list[0];
  if (!isRecord(first) || typeof first[field] !== "number") return undefined;
  return String(first[field]);
}

export type PaginationStyle = "offset" | "cursor" | "both" | "neither";

const OFFSET_KEYS = ["next_page", "previous_page"];
const CURSOR_KEYS = ["meta", "links"];

/**
 * Which of Zendesk's two pagination styles an endpoint answered with.
 *
 * It matters twice over: `narrow-plan.ts` can only express the OFFSET one, so a
 * catalogued endpoint that answers cursor-style is an endpoint the proxy cannot
 * walk — and `VENDOR_POSITIONS` strips exactly these four keys, so a fifth
 * spelling would be a vendor position handed back to the agent.
 */
export function paginationStyle(body: string): PaginationStyle {
  const keys = new Set(bodyKeys(body));
  const offset = OFFSET_KEYS.some((key) => keys.has(key));
  const cursor = CURSOR_KEYS.some((key) => keys.has(key));
  if (offset && cursor) return "both";
  if (offset) return "offset";
  if (cursor) return "cursor";
  return "neither";
}

/**
 * Two counts as a RELATION, never as two numbers.
 *
 * "3412 vs 87" is how many tickets a customer has, and this evidence is
 * committed. "greater than" is the whole fact the check needs.
 */
export function relation(left: number, right: number): string {
  if (left === right) return "equal";
  return left > right ? "greater than" : "fewer than";
}

/** Whether a count is zero, said without saying what it is when it is not. */
export function population(count: number): string {
  return count === 0 ? "empty" : "non-empty";
}
