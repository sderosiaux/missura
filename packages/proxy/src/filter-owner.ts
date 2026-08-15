import type { FilterRule } from "@missura/core";
import { ownerId } from "./filter-json";

/**
 * The one question the FILTER asks of every object: is this ours?
 *
 * It lives alone because it is the whole security boundary of the engine —
 * everything else in `filter.ts` is tree walking. There is no third answer:
 * "we could not tell" costs exactly what "it is not ours" costs.
 */

/**
 * A–Z → a–z and nothing else. `String.toLowerCase()` is Unicode-aware, which
 * is the wrong tool here: it folds `K` (U+212A KELVIN SIGN) onto `k`, so a
 * repository the vendor reads as a different name would compare equal to a
 * mission's. Widening the set of strings that count as a mission identifier is
 * how a filter starts keeping foreign objects.
 */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 32),
  );
}

function matches(resolved: string, expected: string, rule: FilterRule): boolean {
  return rule.ownerMatch === "ascii-case-insensitive"
    ? asciiLower(resolved) === asciiLower(expected)
    : resolved === expected;
}

/**
 * True when the object's owner resolves to one of the rule's expected owners.
 * An unresolvable owner (missing key, `null`, a non-object on the way, a leaf
 * that is not a non-empty string) resolves to `undefined` and therefore
 * matches nothing — including an empty expected set, which owns nothing at all.
 */
export function isOwned(object: unknown, rule: FilterRule): boolean {
  const resolved = ownerId(object, rule.ownerPath);
  if (resolved === undefined) return false;
  return rule.expectedOwnerIds.some((expected) =>
    matches(resolved, expected, rule),
  );
}
