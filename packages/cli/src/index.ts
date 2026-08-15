import { parseArgs } from "node:util";
import type { ProxyServers } from "@missura/proxy";
import { initCommand } from "./init";
import type { CliIo } from "./io";
import { runCommand } from "./run";
import { DEFAULT_TTL_SECONDS, tokenCommand } from "./token";

export type { CliIo } from "./io";
export { defaultIo } from "./io";
export { resolveHome, type MissuraPaths } from "./paths";

export interface CliResult {
  code: number;
  /** Present only for `run`: the caller owns shutdown (signals, or a test). */
  servers?: ProxyServers;
}

const USAGE = [
  "missura — vendor credentials out of the agent",
  "",
  "  missura init                     store vendor credentials in the encrypted vault",
  "  missura run [--linear-port N]    boot one proxy listener per connector",
  "              [--github-port N]",
  "  missura token [--ttl SECONDS]    print a dev mission token (default 3600)",
  "",
  "MISSURA_HOME overrides ~/.missura for every file.",
].join("\n");

const OPTIONS = {
  ttl: { type: "string" },
  "linear-port": { type: "string" },
  "github-port": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return value;
}

const MAX_PORT = 65535;

/**
 * Validated at parse time, before the vault is opened: an out-of-range port
 * would otherwise surface as an opaque `listen` error after the credentials
 * were already decrypted. `0` means "let the OS pick" (used by the tests).
 */
function portOption(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PORT) {
    throw new Error(
      `--${name} must be an integer between 0 and 65535 (0 lets the OS pick)`,
    );
  }
  return value;
}

async function dispatch(
  command: string | undefined,
  values: Partial<Record<keyof typeof OPTIONS, string | boolean>>,
  io: CliIo,
): Promise<CliResult> {
  const str = (name: keyof typeof OPTIONS): string | undefined => {
    const value = values[name];
    return typeof value === "string" ? value : undefined;
  };
  switch (command) {
    case "init":
      return { code: await initCommand(io) };
    case "token": {
      const ttl = positiveInt("ttl", str("ttl"), DEFAULT_TTL_SECONDS);
      if (ttl === 0) throw new Error("--ttl must be greater than 0");
      return { code: tokenCommand(io, ttl) };
    }
    case "run": {
      const linearPort = portOption("linear-port", str("linear-port"));
      const githubPort = portOption("github-port", str("github-port"));
      const servers = await runCommand(io, {
        ...(linearPort === undefined ? {} : { linearPort }),
        ...(githubPort === undefined ? {} : { githubPort }),
      });
      return { code: 0, servers };
    }
    default:
      throw new Error(
        command === undefined ? "no command given" : `unknown command: ${command}`,
      );
  }
}

/**
 * Single entry point for both the bin and the tests. Every failure path ends
 * here: one message on stderr, exit code 1, no stack trace and never the
 * offending value (it could be a credential).
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
): Promise<CliResult> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
    });
    if (values.help === true) {
      io.stdout(USAGE);
      return { code: 0 };
    }
    return await dispatch(positionals[0], values, io);
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : "unexpected error");
    io.stderr("");
    io.stderr(USAGE);
    return { code: 1 };
  }
}
