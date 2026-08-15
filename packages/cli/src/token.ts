import { loadOrCreateKey, signDevToken } from "@missura/core";
import type { CliIo } from "./io";
import { resolveHome } from "./paths";

/**
 * The M1 shortcut, now fenced. `signDevToken` mints a scope-all token: it has
 * no customer, no repos and nothing for NARROW to shrink, so it is exactly
 * what M2 exists to make unnecessary. `--dev` makes reaching for it a choice
 * the operator typed, not a default they drifted into.
 */
export function tokenCommand(
  io: CliIo,
  ttlSeconds: number,
  dev: boolean,
): number {
  if (!dev) {
    throw new Error(
      "missura token mints an unscoped dev token — use `missura exec --customer <name> --purpose <why> -- <cmd>` for a real mission, or pass --dev if you meant it",
    );
  }
  const paths = resolveHome(io.env);
  const key = loadOrCreateKey(paths.signingKeyPath);
  io.stdout(signDevToken({ key, ttlSeconds }));
  io.stderr("warning: unscoped dev token — deprecated, scoped missions live in missura exec");
  return 0;
}
