import { MAX_TTL_SECONDS } from "@missura/core";

export const DEFAULT_TTL_SECONDS = 3600;

const TTL_RE = /^(\d+)(m|s)?$/;

/**
 * `30m`, `1800`, `45s` — the three shapes an operator actually types. Anything
 * else is refused rather than coerced: a `--ttl 30` that silently meant 30
 * seconds when the operator meant 30 minutes is the kind of surprise that ends
 * with a mission dying mid-run.
 *
 * The 60 minute cap (SPEC §4.2) is enforced here, before the signing key is
 * touched, so the operator reads the cap in the error instead of discovering a
 * clamped lifetime inside a token.
 */
export function parseTtl(
  raw: string | undefined,
  fallback: number = DEFAULT_TTL_SECONDS,
): number {
  if (raw === undefined) return fallback;
  const match = TTL_RE.exec(raw.trim());
  const digits = match?.[1];
  if (digits === undefined) {
    throw new Error("--ttl must look like 30m, 45s or 1800 (seconds)");
  }
  const value = Number(digits) * (match?.[2] === "m" ? 60 : 1);
  if (value <= 0) {
    throw new Error("--ttl must be a positive duration");
  }
  if (value > MAX_TTL_SECONDS) {
    throw new Error(
      `--ttl must not exceed ${String(MAX_TTL_SECONDS)} seconds (60 minutes)`,
    );
  }
  return value;
}
