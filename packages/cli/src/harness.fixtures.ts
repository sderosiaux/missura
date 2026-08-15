import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./index";
import type { CliIo } from "./io";

export const LINEAR_KEY = "lin_api_test_key";
export const GITHUB_TOKEN = "ghp_test_token";

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
