import { loadOrCreateKey, signDevToken } from "@missura/core";
import type { CliIo } from "./io";
import { resolveHome } from "./paths";

export const DEFAULT_TTL_SECONDS = 3600;

/**
 * Prints the token and nothing else, so `MISSURA_TOKEN=$(missura token)` is
 * safe. Scope-all dev token only — real scoped missions land in M2.
 */
export function tokenCommand(io: CliIo, ttlSeconds: number): number {
  const paths = resolveHome(io.env);
  const key = loadOrCreateKey(paths.signingKeyPath);
  io.stdout(signDevToken({ key, ttlSeconds }));
  return 0;
}
