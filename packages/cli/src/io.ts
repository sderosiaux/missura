import { createInterface } from "node:readline/promises";

/**
 * The CLI's whole contact surface with the outside world. Injected rather than
 * reached for so commands stay unit-testable and so a test can never
 * accidentally read the operator's real `~/.missura` or their terminal.
 */
export interface CliIo {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  isTTY: boolean;
  prompt: (label: string) => Promise<string>;
}

/**
 * M1 prompts in the clear (no terminal echo suppression yet) but the value is
 * never printed back, never logged and never leaves the vault afterwards.
 */
async function ask(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(label);
  } finally {
    rl.close();
  }
}

export function defaultIo(): CliIo {
  return {
    env: process.env,
    stdout: (line): void => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line): void => {
      process.stderr.write(`${line}\n`);
    },
    // Falsy when stdin is a pipe: a non-TTY must never take the prompt path.
    isTTY: process.stdin.isTTY,
    prompt: ask,
  };
}
