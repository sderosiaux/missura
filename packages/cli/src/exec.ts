import { spawn } from "node:child_process";
import { constants } from "node:os";
import {
  assertEntityKey,
  openEntityGraph,
  resolveMissionScope,
  type MissionScope,
} from "@missura/core";
import {
  DEFAULT_GITHUB_PORT,
  DEFAULT_LINEAR_PORT,
  DEFAULT_ZENDESK_PORT,
  INTROSPECTION_PATH,
  operationCatalogue,
} from "@missura/proxy";
import type { CliIo } from "./io";
import { openStore } from "./missions";
import { resolveHome } from "./paths";

export interface ExecOptions {
  purpose: string;
  actor: string;
  /** The entity's whole key — `customer:adeo`, `project:atlas`. Never a name. */
  entity?: string;
  repos?: readonly string[];
  /**
   * Operation NAMES granted on top of the read verbs — the only way this
   * mission reaches a write. Checked against the catalogue before a token
   * exists (`MissionStore`), so a typo fails here, not at the first call.
   */
  allow?: readonly string[];
  ttlSeconds: number;
  /** The command and its arguments, as given after `--`. */
  argv: readonly string[];
  entitiesPath?: string;
  linearPort?: number;
  githubPort?: number;
  zendeskPort?: number;
}

/**
 * Vendor credentials the parent shell may well be holding. They are removed
 * from the child's environment rather than merely not added: the whole point
 * of a mission is that the agent cannot reach the vendor without the proxy,
 * and an inherited key would silently give it a second, unaudited path.
 *
 * What this is not: a sandbox. The child runs as the same user, so it can read
 * ~/.missura — operator.key mints it a mission of its own, vault.key plus
 * vault.json decrypt the vendor credentials outright. Stripping the
 * environment removes the accident, not the capability; containment is a
 * container or a separate user (SPEC §3).
 */
const STRIPPED: ReadonlySet<string> = new Set([
  "LINEAR_API_KEY",
  "GITHUB_TOKEN",
  "ZENDESK_API_TOKEN",
  "ZENDESK_EMAIL",
]);

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
  const github = origin(options.githubPort ?? DEFAULT_GITHUB_PORT);
  env.MISSION_TOKEN = token;
  env.LINEAR_API_URL = `${linear}/graphql`;
  env.GITHUB_API_URL = github;
  // Where the child asks what its mission is. Every data-plane listener serves
  // the route; the GitHub one is advertised because a plain GET that fails
  // there fails in a REST envelope, where the Linear listener would answer a
  // GET with a GraphQL error document.
  env.MISSURA_MISSION_URL = `${github}${INTROSPECTION_PATH}`;
  // Handed over unconditionally, like the other two: whether this proxy serves
  // Zendesk is a boot-time fact of `missura run`, not of the mission, and a
  // child that cannot reach the port learns that from a connection refused
  // rather than from an origin that was quietly never set.
  env.ZENDESK_API_URL = origin(options.zendeskPort ?? DEFAULT_ZENDESK_PORT);
  return env;
}

function scopeOf(options: ExecOptions): MissionScope {
  const repos = [...(options.repos ?? [])];
  const scope: MissionScope = {};
  // Checked here, before anything is opened: a key nobody could look up must
  // not reach the graph as an "unknown entity" it never had a chance to hold.
  if (options.entity !== undefined) scope.entity = assertEntityKey(options.entity);
  if (repos.length > 0) scope.repos = repos;
  if (scope.entity === undefined && repos.length === 0) {
    throw new Error(
      "a mission must name a target: --entity <type:name> and/or --repo owner/name",
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
 * The mission is minted through the entity graph first: an unresolvable scope
 * must fail before a token exists, not resolve to nothing at request time. What
 * the graph declined to use travels onto the record beside it.
 */
export async function execCommand(
  io: CliIo,
  options: ExecOptions,
): Promise<number> {
  const paths = resolveHome(io.env);
  const scope = scopeOf(options);
  const graph = openEntityGraph(options.entitiesPath ?? paths.entitiesPath);
  const { scope: resolved, resolution } = resolveMissionScope(graph, scope);

  // The whole catalogue: `exec` mints without booting a proxy, so it cannot
  // know which connections the running one serves. A name that exists but is
  // not served there is refused at the first call as unknown, like any other.
  const store = openStore(paths, operationCatalogue({ zendesk: true }));
  const allow = options.allow ?? [];
  const { record, token } = store.create(
    {
      purpose: options.purpose,
      actor: options.actor,
      scope,
      ttlSeconds: options.ttlSeconds,
      ...(allow.length === 0 ? {} : { allow }),
    },
    resolved,
    // The graph's own account of the scope, degradations included. Dropped
    // here, "this run never saw Linear" would be unanswerable afterwards.
    resolution,
  );
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
