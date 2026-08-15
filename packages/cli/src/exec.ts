import { spawn } from "node:child_process";
import { constants } from "node:os";
import {
  loadEntityMap,
  resolveScope,
  type MissionScope,
} from "@missura/core";
import { DEFAULT_GITHUB_PORT, DEFAULT_LINEAR_PORT } from "@missura/proxy";
import type { CliIo } from "./io";
import { openStore } from "./missions";
import { resolveHome } from "./paths";

export interface ExecOptions {
  purpose: string;
  actor: string;
  customer?: string;
  repos?: readonly string[];
  ttlSeconds: number;
  /** The command and its arguments, as given after `--`. */
  argv: readonly string[];
  entitiesPath?: string;
  linearPort?: number;
  githubPort?: number;
}

/**
 * Vendor credentials the parent shell may well be holding. They are removed
 * from the child's environment rather than merely not added: the whole point
 * of a mission is that the agent cannot reach the vendor without the proxy,
 * and an inherited key would silently give it a second, unaudited path.
 */
const STRIPPED: ReadonlySet<string> = new Set(["LINEAR_API_KEY", "GITHUB_TOKEN"]);

function origin(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

function childEnv(
  io: CliIo,
  token: string,
  options: ExecOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(io.env).filter(([name]) => !STRIPPED.has(name)),
  );
  const linear = origin(options.linearPort ?? DEFAULT_LINEAR_PORT);
  env.MISSION_TOKEN = token;
  env.LINEAR_API_URL = `${linear}/graphql`;
  env.GITHUB_API_URL = origin(options.githubPort ?? DEFAULT_GITHUB_PORT);
  return env;
}

function scopeOf(options: ExecOptions): MissionScope {
  const repos = [...(options.repos ?? [])];
  const scope: MissionScope = {};
  if (options.customer !== undefined) scope.customer = options.customer;
  if (repos.length > 0) scope.repos = repos;
  if (scope.customer === undefined && repos.length === 0) {
    throw new Error(
      "a mission must name a target: --customer <name> and/or --repo owner/name",
    );
  }
  return scope;
}

/** Exit like a shell would: 128 + signal number when the child was killed. */
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal !== null) return 128 + constants.signals[signal];
  return code ?? 1;
}

function spawnChild(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  onStarted: (kill: (signal: NodeJS.Signals) => void) => void,
): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error("missura exec needs a command after `--`");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    onStarted((signal) => {
      child.kill(signal);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve(exitCode(code, signal));
    });
  });
}

/**
 * Wraps a command in a mission: mints one locally (same store the operator API
 * writes to), hands the child a mission token and the proxy origins, and
 * revokes on the way out — including on Ctrl-C, so an interrupted agent run
 * never leaves a live grant behind.
 *
 * The mission is minted through the entity map first: an unresolvable scope
 * must fail before a token exists, not resolve to nothing at request time.
 */
export async function execCommand(
  io: CliIo,
  options: ExecOptions,
): Promise<number> {
  const paths = resolveHome(io.env);
  const scope = scopeOf(options);
  const map = loadEntityMap(options.entitiesPath ?? paths.entitiesPath);
  resolveScope(map, scope);

  const store = openStore(paths);
  const { record, token } = store.create({
    purpose: options.purpose,
    actor: options.actor,
    scope,
    ttlSeconds: options.ttlSeconds,
  });
  const revoke = (): void => {
    try {
      store.revoke(record.id);
    } catch {
      // Already revoked elsewhere: nothing left to do, and nothing to say.
    }
  };

  // Printed on stderr: stdout belongs to the child, so `missura exec ... | jq`
  // keeps working.
  io.stderr(`mission ${record.id}  ttl ${String(options.ttlSeconds)}s`);

  let interrupt: (() => void) | undefined;
  try {
    return await spawnChild(options.argv, childEnv(io, token, options), (kill) => {
      interrupt = (): void => {
        revoke();
        kill("SIGINT");
      };
      process.once("SIGINT", interrupt);
    });
  } finally {
    if (interrupt !== undefined) process.off("SIGINT", interrupt);
    revoke();
  }
}
