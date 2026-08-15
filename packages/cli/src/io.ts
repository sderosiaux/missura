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

export interface MaskedInput {
  /** What the operator has typed so far — never written anywhere. */
  value: string;
  /** What the terminal has been shown: asterisks, erases and a newline. */
  echo: string;
  status: "typing" | "done" | "aborted";
}

const BACKSPACE = "\u007f";
const BACKSPACE_ALT = "\b";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
/** Move left, overwrite with a space, move left again: one asterisk erased. */
const ERASE = "\b \b";

/**
 * The masking rule, as a pure transition so it can be tested without a
 * terminal: the typed character goes to `value`, an asterisk goes to `echo`,
 * and the two never mix. Unknown control characters are swallowed rather than
 * echoed — an arrow key must not paint an asterisk that has no character
 * behind it, or the operator would count wrong on a credential they cannot see.
 */
export function pressKey(state: MaskedInput, char: string): MaskedInput {
  if (state.status !== "typing") return state;
  if (char === "\r" || char === "\n" || char === CTRL_D) {
    return { ...state, echo: `${state.echo}\n`, status: "done" };
  }
  if (char === CTRL_C) {
    return { value: "", echo: `${state.echo}\n`, status: "aborted" };
  }
  if (char === BACKSPACE || char === BACKSPACE_ALT) {
    if (state.value.length === 0) return state;
    return {
      ...state,
      value: state.value.slice(0, -1),
      echo: `${state.echo}${ERASE}`,
    };
  }
  if (char < " ") return state;
  return { ...state, value: state.value + char, echo: `${state.echo}*` };
}

interface RawCapable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

function setRaw(input: NodeJS.ReadableStream, raw: boolean): void {
  const maybe = input as unknown as RawCapable;
  if (maybe.isTTY === true && typeof maybe.setRawMode === "function") {
    maybe.setRawMode(raw);
  }
}

/**
 * Reads one line with the input echoed as asterisks. Raw mode is required:
 * with cooked input the terminal itself would print the credential before the
 * process ever sees it. Ctrl-C rejects instead of killing the process so the
 * caller can leave nothing half-written behind.
 */
export function readMasked(
  input: NodeJS.ReadableStream,
  write: (chunk: string) => void,
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let state: MaskedInput = { value: "", echo: "", status: "typing" };
    write(label);
    setRaw(input, true);
    input.resume();

    const finish = (err?: Error, value?: string): void => {
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      setRaw(input, false);
      input.pause();
      if (err !== undefined) reject(err);
      else resolve(value ?? "");
    };
    function onData(chunk: Buffer | string): void {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        const next = pressKey(state, char);
        write(next.echo.slice(state.echo.length));
        state = next;
        if (state.status !== "typing") break;
      }
      if (state.status === "done") finish(undefined, state.value);
      else if (state.status === "aborted") finish(new Error("input aborted"));
    }
    function onError(err: Error): void {
      finish(err);
    }
    function onEnd(): void {
      finish(new Error("input ended before the value was entered"));
    }

    input.on("data", onData);
    input.on("error", onError);
    input.on("end", onEnd);
  });
}

/**
 * On a terminal the value is masked as it is typed; everywhere else (a pipe)
 * readline reads the line without any terminal echo to suppress. Either way
 * the value is never printed back, never logged and never leaves the vault.
 */
async function ask(label: string): Promise<string> {
  if (process.stdin.isTTY) {
    return readMasked(
      process.stdin,
      (chunk) => {
        process.stderr.write(chunk);
      },
      label,
    );
  }
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
