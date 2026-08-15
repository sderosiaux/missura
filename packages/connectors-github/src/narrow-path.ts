/** Dummy base so `URL` can parse pathname + query safely. */
export const DUMMY_BASE = "https://vendor.invalid";

/** Enough to see through `%252f`; a bound, so a crafted path cannot spin here. */
const MAX_DECODE_PASSES = 3;

/** GitHub's own owner/repo charset. */
const VENDOR_NAME = /^[A-Za-z0-9._-]+$/;

/** Decodes until stable, so a double-encoded separator cannot hide one pass deep. */
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
  /** The segments the VENDOR will act on: decoded, dot-collapsed. */
  segments: string[];
  /** Those same segments re-encoded — the target the decision is about. */
  path: string;
  /** The client's query string, sanitized by the caller if it matters. */
  search: string;
}

/**
 * The request as decided on, and therefore as forwarded.
 *
 * `URL` normalizes `..` and `%2e%2e` but leaves `..%2f` alone, while
 * api.github.com decodes `%2F` as a path separator — a live
 * `/repos/octokit/octokit.js/contents/src%2Findex.ts` answers 200. Deciding on
 * the raw segments would therefore let `/repos/acme/product/..%2f..%2fglobex/x`
 * read as a path inside acme/product.
 *
 * So: decode, treat `\` as a separator too (some normalizers do), remove dot
 * segments by hand, then rebuild. Each segment is re-encoded with
 * `encodeURIComponent`, so a decoded `/` cannot come back as a separator: what
 * travels is exactly the target the decision was taken on, never the client's
 * own spelling of it. Undecodable input is refused rather than guessed at.
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
  return {
    segments,
    path: `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`,
    search: url.search,
  };
}

/**
 * True for a segment GitHub could actually name an owner or a repo. Anything
 * else is refused rather than compared: `K` (KELVIN SIGN) lowercases to `k`,
 * so a case-insensitive scope check would call `acme/Kafka` in scope for a
 * mission holding `acme/kafka` while the vendor reads a different name.
 */
export function isVendorName(segment: string): boolean {
  return VENDOR_NAME.test(segment);
}
