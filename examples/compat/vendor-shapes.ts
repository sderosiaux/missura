import { bodyDescriptor } from "./writable";

/**
 * What each vendor's own error looks like, and which statuses its clients are
 * built to handle.
 *
 * This is the half of "same API" that has nothing to do with data: a refusal an
 * SDK cannot parse never reaches the code that has to act on it, and a status
 * outside the vendor's vocabulary falls through every branch a generated client
 * has. Both are recorded here as data so a classification can name which
 * envelope it was measuring against.
 */

export type Vendor = "linear" | "github" | "zendesk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GitHub: `{"message": "...", "documentation_url": "..."}` — the message is the
 * only field every error carries, and it is the one Octokit surfaces.
 */
function githubEnvelope(body: unknown): boolean {
  return isRecord(body) && typeof body.message === "string";
}

/**
 * Zendesk publishes two: the short form `{"error":"RecordNotFound",
 * "description":"Not found"}` and the detailed one
 * `{"error":{"title":"...","message":"..."}}`. Both are accepted; anything else
 * is not a Zendesk error.
 */
function zendeskEnvelope(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (typeof body.error === "string") return true;
  return isRecord(body.error) && typeof body.error.title === "string";
}

/** GraphQL: a refusal is a 200 carrying `errors[]`, or any body that has one. */
function linearEnvelope(body: unknown): boolean {
  return isRecord(body) && Array.isArray(body.errors);
}

const ENVELOPES: Record<Vendor, (body: unknown) => boolean> = {
  github: githubEnvelope,
  zendesk: zendeskEnvelope,
  linear: linearEnvelope,
};

export interface EnvelopeVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Whether a body an SDK will meet as an error is one it can parse.
 *
 * The reason DESCRIBES the body instead of quoting it. `body.slice(0, 120)`
 * used to travel into the report and the manifest, and the first 120 bytes of a
 * vendor error are exactly where its `description` lives — a Zendesk one names
 * the record it could not find. The key set and the size say why the envelope
 * check failed, which is all a reader has to act on.
 */
export function checkErrorEnvelope(
  vendor: Vendor,
  body: string,
): EnvelopeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      reason: `the refusal body is not JSON, so no SDK can parse it — it is ${bodyDescriptor(body)}`,
    };
  }
  if (ENVELOPES[vendor](parsed)) return { ok: true };
  return {
    ok: false,
    reason: `the refusal body is JSON but not ${vendor}'s own error envelope — it is ${bodyDescriptor(body)}`,
  };
}

/**
 * The statuses each vendor's clients already meet. A status outside this set is
 * one the SDK has no branch for — it is not a difference in the data, it is a
 * difference an integration cannot handle at all.
 */
const VOCABULARY: Record<Vendor, ReadonlySet<number>> = {
  github: new Set([
    200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 409, 410, 422, 429, 500,
    502, 503,
  ]),
  zendesk: new Set([
    200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503,
  ]),
  linear: new Set([200, 400, 401, 403, 404, 429, 500, 502, 503]),
};

export function inVocabulary(vendor: Vendor, status: number): boolean {
  return VOCABULARY[vendor].has(status);
}

/** `application/json; charset=utf-8` → `application/json`. */
export function mediaType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  return contentType.split(";")[0]?.trim().toLowerCase();
}
