import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./index";
import type { CliIo } from "./io";
import { resolveHome } from "./paths";

export const LINEAR_KEY = "lin_api_test_key";
export const GITHUB_TOKEN = "ghp_test_token";

const CONFIRMED = {
  method: "manual",
  status: "confirmed",
  confirmedBy: "ops@missura.dev",
  confirmedAt: "2026-08-14T09:12:03.000Z",
} as const;

/**
 * The graph the CLI tests mint against — the real file shape, not the flat map
 * that preceded it, so a stale fixture fails at the loader rather than quietly
 * resolving to nothing.
 *
 * `customer:acme` is whole: every system confirmed. `customer:zoetis` is the
 * degraded one — its Linear link exists and nobody has signed it off, which is
 * exactly the case a mission must survive narrower rather than refuse.
 */
export const ENTITY_GRAPH = {
  version: 1,
  entities: {
    "customer:acme": {
      displayName: "Acme",
      domains: ["acme.example"],
      links: [
        { system: "linear", id: "c_18", evidence: "operator", ...CONFIRMED },
        {
          system: "github",
          id: "acme-corp/product",
          evidence: "operator",
          ...CONFIRMED,
        },
        { system: "zendesk", id: "4200", evidence: "operator", ...CONFIRMED },
      ],
    },
    "customer:zoetis": {
      displayName: "Zoetis",
      domains: ["zoetis.example"],
      links: [
        {
          system: "linear",
          id: "c_77",
          evidence: "Linear customer name matches the display name",
          method: "inferred",
          status: "proposed",
        },
        {
          system: "github",
          id: "acme-corp/zoetis",
          evidence: "operator",
          ...CONFIRMED,
        },
        { system: "zendesk", id: "4300", evidence: "operator", ...CONFIRMED },
      ],
    },
  },
};

export const ZENDESK_SUBDOMAIN = "acme";
export const ZENDESK_EMAIL = "ops@acme.example";
export const ZENDESK_TOKEN = "zd_test_token";

/** The env a `missura init` needs to configure the third connection too. */
export const ZENDESK_INIT_ENV: Record<string, string> = {
  MISSURA_INIT_ZENDESK_SUBDOMAIN: ZENDESK_SUBDOMAIN,
  MISSURA_INIT_ZENDESK_EMAIL: ZENDESK_EMAIL,
  MISSURA_INIT_ZENDESK_TOKEN: ZENDESK_TOKEN,
};

/** Installs the graph into a harness's `MISSURA_HOME`. */
export function writeEntityGraph(h: Harness, graph: unknown = ENTITY_GRAPH): void {
  writeFileSync(
    resolveHome(h.io.env).entitiesPath,
    JSON.stringify(graph),
    "utf8",
  );
}

export interface Harness {
  io: CliIo;
  out: string[];
  err: string[];
  home: string;
}

const homes: string[] = [];

/**
 * A CLI wired to a throwaway `MISSURA_HOME` and to arrays instead of the
 * terminal: no test can read the operator's real install, and every printed
 * line stays assertable (a credential leaking to stdout is a test failure,
 * not a scrollback surprise).
 */
export function harness(env: Record<string, string> = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "missura-cli-"));
  homes.push(home);
  const out: string[] = [];
  const err: string[] = [];
  return {
    home,
    out,
    err,
    io: {
      env: { MISSURA_HOME: home, ...env },
      stdout: (line): void => {
        out.push(line);
      },
      stderr: (line): void => {
        err.push(line);
      },
      isTTY: false,
      prompt: (): Promise<string> => {
        throw new Error("prompt must not be called in these tests");
      },
    },
  };
}

export function cleanupHomes(): void {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
}

/** A harness whose home already holds a vault, a signing key and an operator key. */
export async function initedHarness(
  env: Record<string, string> = {},
): Promise<Harness> {
  const h = harness({
    MISSURA_INIT_LINEAR_KEY: LINEAR_KEY,
    MISSURA_INIT_GITHUB_TOKEN: GITHUB_TOKEN,
    ...env,
  });
  const result = await run(["init"], h.io);
  if (result.code !== 0) throw new Error(h.err.join("\n"));
  h.out.length = 0;
  return h;
}
