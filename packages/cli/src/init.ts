import { loadOrCreateKey, saveVault, type VaultData } from "@missura/core";
import type { CliIo } from "./io";
import { resolveHome } from "./paths";

interface CredentialSpec {
  connection: string;
  envVar: string;
  label: string;
}

const CREDENTIALS: readonly CredentialSpec[] = [
  {
    connection: "linear",
    envVar: "MISSURA_INIT_LINEAR_KEY",
    label: "Linear API key",
  },
  {
    connection: "github",
    envVar: "MISSURA_INIT_GITHUB_TOKEN",
    label: "GitHub token",
  },
];

/**
 * Reads one credential from the environment, falling back to an interactive
 * prompt only on a real TTY. Empty is a hard failure in both paths: an empty
 * credential would produce a vault that boots and then fails at the vendor,
 * which is exactly the surprise-later outcome the proxy exists to avoid.
 */
async function readCredential(
  io: CliIo,
  spec: CredentialSpec,
): Promise<string> {
  const fromEnv = io.env[spec.envVar];
  if (fromEnv !== undefined) {
    const value = fromEnv.trim();
    if (value.length === 0) {
      throw new Error(`${spec.envVar} is empty — ${spec.connection} credential required`);
    }
    return value;
  }
  if (!io.isTTY) {
    throw new Error(
      `missing ${spec.connection} credential — set ${spec.envVar} or run missura init on a terminal`,
    );
  }
  const answer = (await io.prompt(`${spec.label}: `)).trim();
  if (answer.length === 0) {
    throw new Error(`empty ${spec.connection} credential — nothing was written`);
  }
  return answer;
}

/**
 * Collects the vendor credentials, encrypts them and mints the signing key the
 * proxy verifies mission tokens with. Only file paths are printed — a
 * credential must never reach stdout, a scrollback buffer or a CI log.
 */
export async function initCommand(io: CliIo): Promise<number> {
  const paths = resolveHome(io.env);
  const data: VaultData = {};
  for (const spec of CREDENTIALS) {
    data[spec.connection] = await readCredential(io, spec);
  }

  const vaultKey = loadOrCreateKey(paths.vaultKeyPath);
  saveVault(paths.vaultPath, vaultKey, data);
  loadOrCreateKey(paths.signingKeyPath);
  // The operator plane's bearer. Created here so `missura run` never has to
  // mint one at boot: a key that appears on first use is a key nobody backed up.
  loadOrCreateKey(paths.operatorKeyPath);

  io.stdout(`vault       ${paths.vaultPath}`);
  io.stdout(`vault key   ${paths.vaultKeyPath}`);
  io.stdout(`signing key ${paths.signingKeyPath}`);
  io.stdout(`operator key ${paths.operatorKeyPath}`);
  io.stdout(`events      ${paths.eventsDir}`);
  io.stdout("");
  io.stdout(
    "next: missura run   (then: missura exec --customer <name> --purpose <why> -- <cmd>)",
  );
  return 0;
}
