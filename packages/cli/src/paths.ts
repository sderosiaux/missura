import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every file the CLI touches, derived from a single root so a test (or a
 * second operator profile) can relocate the whole install with `MISSURA_HOME`.
 */
export interface MissuraPaths {
  home: string;
  /** AES-256-GCM key protecting the vendor credentials at rest. */
  vaultKeyPath: string;
  vaultPath: string;
  /** HMAC key the proxy verifies mission tokens against. */
  signingKeyPath: string;
  eventsDir: string;
}

export const DEFAULT_HOME_DIRNAME = ".missura";

export function resolveHome(env: NodeJS.ProcessEnv): MissuraPaths {
  const override = env.MISSURA_HOME?.trim();
  const home =
    override === undefined || override.length === 0
      ? join(homedir(), DEFAULT_HOME_DIRNAME)
      : override;
  return {
    home,
    vaultKeyPath: join(home, "vault.key"),
    vaultPath: join(home, "vault.json"),
    signingKeyPath: join(home, "signing.key"),
    eventsDir: join(home, "events"),
  };
}
