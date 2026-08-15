/** Dummy base so `URL` can parse pathname + query safely. */
export const DUMMY_BASE = "https://vendor.invalid";

/** Enough to see through `%252f`; a bound, so a crafted path cannot spin here. */
const MAX_DECODE_PASSES = 3;

/**
 * A Zendesk resource id, as the vendor spells it: a positive integer. Ids are
 * `"id": 35436` in every object the catalog touches, so anything else in an id
 * position is not a resource — it is `show_many`, `me`, `autocomplete`, or a
 * probe. Refusing rather than comparing is what keeps `/api/v2/users/me` from
 * reading as "show user `me`".
 */
const VENDOR_ID = /^[0-9]+$/;

/** Zendesk answers the same resource with and without this suffix. */
const JSON_SUFFIX = ".json";

function decodeFully(value: string): string | undefined {
  let current = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Malformed percent-encoding: we cannot say what the vendor would read,
      // so we do not guess.
      return undefined;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

export interface CanonicalRequest {
  /** The segments the VENDOR will act on: decoded, dot-collapsed, unsuffixed. */
  segments: string[];
  /** Those same segments re-encoded — the target the decision is about. */
  path: string;
  /** The client's query string, sanitized by the caller if it matters. */
  search: string;
}

/**
 * The request as decided on, and therefore as forwarded.
 *
 * Same reasoning as the GitHub connector's: `URL` normalizes `..` and `%2e%2e`
 * but leaves `..%2f` alone, so deciding on the raw segments would let
 * `/api/v2/organizations/1/..%2f..%2fincremental/tickets` read as a path
 * inside an allowed organization. Decode, treat `\` as a separator too, remove
 * dot segments by hand, then rebuild with `encodeURIComponent` so a decoded `/`
 * cannot come back as a separator.
 *
 * The `.json` suffix is Zendesk's own: `/api/v2/tickets/1` and
 * `/api/v2/tickets/1.json` are the same resource. It is stripped BEFORE the
 * decision, so one spelling cannot reach a verdict the other does not, and the
 * stripped form is what travels — deciding on one spelling and forwarding
 * another is how a refusal becomes a credentialed call.
 */
export function canonicalize(path: string): CanonicalRequest | undefined {
  const url = new URL(path, DUMMY_BASE);
  const decoded = decodeFully(url.pathname);
  if (decoded === undefined) return undefined;
  const segments: string[] = [];
  for (const segment of decoded.split(/[/\\]/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const last = segments.length - 1;
  const tail = segments[last];
  if (
    tail !== undefined &&
    tail.length > JSON_SUFFIX.length &&
    tail.endsWith(JSON_SUFFIX)
  ) {
    segments[last] = tail.slice(0, -JSON_SUFFIX.length);
  }
  return {
    segments,
    path: `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`,
    search: url.search,
  };
}

/** True for a segment Zendesk could actually be naming a resource id with. */
export function isVendorId(segment: string): boolean {
  return VENDOR_ID.test(segment);
}
