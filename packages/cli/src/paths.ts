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
  /** Bearer the operator plane (8480) authenticates its caller with. */
  operatorKeyPath: string;
  /** Missions and their revocations — descriptions of grants, never bearers. */
  missionsPath: string;
  /** Business entity → vendor ids. The only place a mission's scope resolves. */
  entitiesPath: string;
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
    operatorKeyPath: join(home, "operator.key"),
    missionsPath: join(home, "missions.json"),
    entitiesPath: join(home, "entities.json"),
    eventsDir: join(home, "events"),
  };
}
