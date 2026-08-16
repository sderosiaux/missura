import { redact } from "./redact";

/**
 * THE BOUNDARY — what may be written into a committed artifact.
 *
 * `manifests/*.json` and `report.md` are committed, under a header promising
 * that no identifier belonging to the human's customers is in them. `redact`
 * called at each site that happened to remember it cannot promise that: the
 * site that forgets is the leak, and one had — `Assumption.claim` was built
 * from the live organization id and written straight through.
 *
 * So the rule is inverted. Nothing reaches an artifact unless it is one of:
 *   - a LITERAL the suite itself authored (a claim, a spec, a section title);
 *   - a PLACEHOLDER (`{org}`, `{id}`, `{uuid}`, `{email}`, `{key}`);
 *   - a STRUCTURAL DESCRIPTOR — a key set, a count as a relation, a kind, a
 *     status, a path, a size bucket. `zendesk-api.ts` already has the pattern
 *     (`bodyKeys`, `relation`, `population`); the error and diff paths simply
 *     did not use it, and every `body.slice(n)` in them is now one of these.
 *
 * Two mechanisms enforce it, and neither is a convention:
 *   - at the SOURCE, nothing interpolates a vendor payload into a string. A
 *     body becomes its key set, an error becomes its class and its cause code;
 *   - at the WRITER, every string an artifact emits goes through `scrub` —
 *     `serializeManifest` via a `JSON.stringify` replacer, so a field added
 *     later cannot bypass it, and `renderReport` over the whole document.
 *
 * `scrub` substitutes two families. The LIVE values this run holds are known
 * exactly — they are the credentials and what discovery found — and are
 * registered here as they are learned. The rest is structural: an id, a UUID,
 * an address, and a key under a container whose child keys the TENANT names.
 *
 * `writable.test.ts` is the proof, and it is the boundary: it stuffs a live
 * value into every field an artifact can carry and reads the emitted bytes.
 */

interface Live {
  pattern: RegExp;
  placeholder: string;
}

const LIVE: Live[] = [];

/**
 * Shorter than this and a value is not an identifier but a coincidence: a
 * two-character organization id would erase every "id" in the prose. Such a
 * value is left to the structural rules below, which is stated rather than
 * hidden — it is the one thing this registry does not cover.
 */
const MIN_LENGTH = 3;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One value this run learned from a live tenant, and the placeholder it reads
 * as. Registered in both spellings that can reach a target: raw, and
 * percent-encoded, because a path travels through a query string.
 */
export function remember(value: string | undefined, placeholder: string): void {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length < MIN_LENGTH) return;
  for (const spelling of new Set([trimmed, encodeURIComponent(trimmed)])) {
    LIVE.push({ pattern: new RegExp(escaped(spelling), "gi"), placeholder });
  }
}

/**
 * A whole discovered-targets or credentials object at once, each field reading
 * as its own name: `{subdomain}`, `{nestedPath}`, `{organizationId}`. Called
 * with the object itself rather than field by field, so a field ADDED to one of
 * those types is registered by the same line that carries it.
 *
 * A list field is named in the plural and its ELEMENTS are not, so
 * `organizationIds: [...]` registers each id as `{organizationId}`.
 */
export function rememberAll(
  values: Readonly<Record<string, string | readonly string[] | undefined>>,
): void {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") {
      remember(value, `{${name}}`);
      continue;
    }
    const singular = name.endsWith("s") ? name.slice(0, -1) : name;
    for (const entry of value ?? []) remember(entry, `{${singular}}`);
  }
}

/** Tests only: the registry is process-wide, and a run registers once. */
export function forgetLive(): void {
  LIVE.length = 0;
}

/** An address is an identifier wherever it turns up, registered or not. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}/g;

/**
 * Containers whose CHILD KEYS the tenant names, not the vendor: Zendesk's
 * `organization_fields` and `user_fields`, and a comment's `metadata.custom`.
 * A key there reads exactly like a schema field — `cf_billing_owner` is
 * indistinguishable from `organization_id` by any pattern — so the container is
 * named instead, and everything directly under one collapses.
 *
 * This list is the boundary's weakest edge, and it is deliberately short: a
 * tenant-keyed container missing from it emits its key names. It is a list of
 * VENDOR schema facts, so it changes only when a vendor adds one.
 */
const TENANT_KEYED =
  /\b(organization_fields|user_fields|metadata\.custom)\.[A-Za-z0-9_-]+/g;

/**
 * Every string that leaves for an artifact. Live values first — they are the
 * most specific — then the structural substitutions.
 */
export function scrub(text: string): string {
  let out = text;
  for (const { pattern, placeholder } of LIVE) {
    out = out.replace(pattern, placeholder);
  }
  return redact(out)
    .replace(EMAIL, "{email}")
    .replace(TENANT_KEYED, "$1.{key}");
}

/**
 * Fails the write rather than the review. It can only fire if a writer stopped
 * scrubbing — which is exactly the edit this guards, since the two writers
 * scrub whole documents rather than chosen fields.
 */
export function assertWritable(text: string, what: string): void {
  for (const { pattern, placeholder } of LIVE) {
    pattern.lastIndex = 0;
    const found = pattern.test(text);
    pattern.lastIndex = 0;
    if (found) {
      throw new Error(
        `refusing to write ${what}: it still carries a live value (${placeholder})`,
      );
    }
  }
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Size as a bucket: a byte count is a fact about the body, not about anyone. */
function size(body: string): string {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes === 0) return "empty";
  if (bytes <= 1024) return "≤1kB";
  return bytes <= 10240 ? "≤10kB" : ">10kB";
}

/**
 * A body as EVIDENCE instead of as a copy of it: what kind of JSON it is, which
 * top-level keys it carries, how big it is. Everything a reader needs to know
 * why an envelope check failed, and nothing that belongs to the tenant.
 */
export function bodyDescriptor(body: string): string {
  const value = parsed(body);
  if (value === undefined) return `not JSON (${size(body)})`;
  if (Array.isArray(value)) {
    return `a JSON array of ${String(value.length)} (${size(body)})`;
  }
  if (value === null || typeof value !== "object") {
    return `a bare JSON ${typeof value} (${size(body)})`;
  }
  const keys = Object.keys(value).sort().join(", ");
  return `a JSON object with keys {${keys}} (${size(body)})`;
}

/**
 * An error as a descriptor. The MESSAGE never travels: a failed fetch quotes
 * the URL it was aiming at, which carries the tenant's own subdomain — that is
 * how a network blip used to write a support subdomain into a committed file.
 * The class and the cause code say what broke; the message goes to stderr,
 * which is not committed.
 */
export function errorDescriptor(err: unknown): string {
  if (!(err instanceof Error)) return `a non-Error value (${typeof err})`;
  const cause: unknown = err.cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String(cause.code)
      : undefined;
  return code === undefined ? err.name : `${err.name} (${code})`;
}
