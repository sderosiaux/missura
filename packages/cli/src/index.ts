import { parseArgs } from "node:util";
import type { ProxyServers } from "@missura/proxy";
import { entityCommand, type EntityOptions } from "./entity";
import { execCommand, type ExecOptions } from "./exec";
import { initCommand } from "./init";
import type { CliIo } from "./io";
import { missionsCommand, revokeCommand } from "./missions";
import { runCommand, type RunOptions } from "./run";
import { tokenCommand } from "./token";
import { parseTtl } from "./ttl";

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
  "                                   zendesk is optional: give a subdomain, an agent",
  "                                   email and an API token, or none of the three",
  "  missura run [--linear-port N]    boot the connector listeners + the operator plane",
  "              [--github-port N] [--zendesk-port N] [--operator-port N]",
  "              [--entities PATH]    zendesk listens only if the vault holds it",
  "  missura exec --purpose WHY       run a command under a scoped mission",
  "              [--entity KEY] [--repo REPO]... [--allow NAME]...",
  "              [--ttl 30m] [--actor WHO]",
  "              KEY is the entity's whole key — customer:adeo, employee:sam,",
  "              project:atlas. The type is yours to choose; the graph in",
  "              ~/.missura/entities.json is what maps it to vendor ids.",
  "              -- <cmd> [args...]",
  "              REPO is owner/name for the whole repository, or",
  "              owner/name:some/path to cover only that path inside it —",
  "              a literal path prefix, recursive (a trailing /** is allowed",
  "              and means the same thing; no other wildcard is). A path-scoped",
  "              repo serves GET /repos/{o}/{r}/contents at or below that path",
  "              and refuses everything else on it: issues, pulls, the repo",
  "              object, search, and any listing above the path.",
  "              NAME grants one WRITE operation by its exact name — e.g.",
  "              github.issue.comment.create — on top of read and search.",
  "              A mission never writes otherwise: not through the vendor's",
  "              own routes, not by any verb. A name not in the catalogue",
  "              is refused before a mission exists; a name the entity",
  "              cannot run is refused as its gap — the cause and the",
  "              command that closes it (see: missura entity show KEY).",
  "              the child runs as your user: vendor keys are removed from its",
  "              environment, but nothing stops it reading ~/.missura — run it",
  "              in a container or as another user if you need containment",
  "  missura entity show KEY [--json] the entity, its links with status, and per",
  "                                   operation: possible, or the one gap and",
  "                                   the command that closes it",
  "  missura entity confirm KEY SYSTEM [ID]",
  "                                   sign a link off — the only thing that widens",
  "                                   a mission. ID is needed when the entity holds",
  "                                   several links on SYSTEM",
  "  missura entity link KEY SYSTEM ID",
  "                                   add a link by hand, confirmed in your name",
  "                                   (SYSTEM is linear, github or zendesk)",
  "  missura missions                 active missions (no token material)",
  "  missura revoke <mission_id>      revoke a mission — effective on the next request",
  "  missura token --dev [--ttl 30m]  unscoped dev token (deprecated, use exec)",
  "",
  "MISSURA_HOME overrides ~/.missura for every file.",
].join("\n");

const OPTIONS = {
  ttl: { type: "string" },
  purpose: { type: "string" },
  actor: { type: "string" },
  entity: { type: "string" },
  repo: { type: "string", multiple: true },
  allow: { type: "string", multiple: true },
  entities: { type: "string" },
  json: { type: "boolean" },
  dev: { type: "boolean" },
  "linear-port": { type: "string" },
  "github-port": { type: "string" },
  "zendesk-port": { type: "string" },
  "operator-port": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = Partial<
  Record<keyof typeof OPTIONS, string | boolean | string[]>
>;

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

function text(values: Values, name: keyof typeof OPTIONS): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function list(values: Values, name: keyof typeof OPTIONS): string[] {
  const value = values[name];
  return Array.isArray(value) ? value : [];
}

/** Provenance, never authorization: who to ask about this run afterwards. */
function actorOf(values: Values, io: CliIo): string {
  const given = text(values, "actor")?.trim();
  if (given !== undefined && given.length !== 0) return given;
  return `${io.env.USER ?? "unknown"}@local`;
}

function execOptions(
  values: Values,
  io: CliIo,
  argv: readonly string[],
): ExecOptions {
  const purpose = text(values, "purpose")?.trim();
  if (purpose === undefined || purpose.length === 0) {
    throw new Error("--purpose is required: a mission says why it exists");
  }
  const options: ExecOptions = {
    purpose,
    actor: actorOf(values, io),
    repos: list(values, "repo"),
    allow: list(values, "allow"),
    ttlSeconds: parseTtl(text(values, "ttl")),
    argv,
  };
  const entity = text(values, "entity")?.trim();
  if (entity !== undefined && entity.length > 0) options.entity = entity;
  const entities = text(values, "entities");
  if (entities !== undefined) options.entitiesPath = entities;
  const linearPort = portOf(values, "linear-port");
  if (linearPort !== undefined) options.linearPort = linearPort;
  const githubPort = portOf(values, "github-port");
  if (githubPort !== undefined) options.githubPort = githubPort;
  const zendeskPort = portOf(values, "zendesk-port");
  if (zendeskPort !== undefined) options.zendeskPort = zendeskPort;
  return options;
}

function portOf(values: Values, name: keyof typeof OPTIONS): number | undefined {
  return portOption(name, text(values, name));
}

async function dispatch(
  command: string | undefined,
  values: Values,
  positionals: readonly string[],
  childArgv: readonly string[],
  io: CliIo,
): Promise<CliResult> {
  switch (command) {
    case "init":
      return { code: await initCommand(io) };
    case "token":
      return {
        code: tokenCommand(io, parseTtl(text(values, "ttl")), values.dev === true),
      };
    case "exec":
      return { code: await execCommand(io, execOptions(values, io, childArgv)) };
    case "missions":
      return { code: missionsCommand(io) };
    case "revoke":
      return { code: revokeCommand(io, positionals[1]) };
    case "entity": {
      const options: EntityOptions = { json: values.json === true, actor: actorOf(values, io) };
      const entities = text(values, "entities");
      if (entities !== undefined) options.entitiesPath = entities;
      return { code: entityCommand(io, positionals[1], positionals.slice(2), options) };
    }
    case "run": {
      const options: RunOptions = {};
      const linearPort = portOf(values, "linear-port");
      if (linearPort !== undefined) options.linearPort = linearPort;
      const githubPort = portOf(values, "github-port");
      if (githubPort !== undefined) options.githubPort = githubPort;
      const zendeskPort = portOf(values, "zendesk-port");
      if (zendeskPort !== undefined) options.zendeskPort = zendeskPort;
      const operatorPort = portOf(values, "operator-port");
      if (operatorPort !== undefined) options.operatorPort = operatorPort;
      const entities = text(values, "entities");
      if (entities !== undefined) options.entitiesPath = entities;
      return { code: 0, servers: await runCommand(io, options) };
    }
    default:
      throw new Error(
        command === undefined ? "no command given" : `unknown command: ${command}`,
      );
  }
}

/**
 * Everything after the first bare `--` belongs to the wrapped command, not to
 * missura. Node's `parseArgs` would fold it into the positionals and lose the
 * boundary — `missura exec ... -- npm test --watch` must not have `--watch`
 * read as a missura flag, nor be silently dropped.
 */
function split(argv: readonly string[]): {
  own: string[];
  child: string[];
} {
  const index = argv.indexOf("--");
  if (index < 0) return { own: [...argv], child: [] };
  return { own: argv.slice(0, index), child: argv.slice(index + 1) };
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
    const { own, child } = split(argv);
    const { values, positionals } = parseArgs({
      args: own,
      options: OPTIONS,
      allowPositionals: true,
    });
    if (values.help === true) {
      io.stdout(USAGE);
      return { code: 0 };
    }
    return await dispatch(positionals[0], values, positionals, child, io);
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : "unexpected error");
    io.stderr("");
    io.stderr(USAGE);
    return { code: 1 };
  }
}
