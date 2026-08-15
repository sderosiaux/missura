import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { pressKey, readMasked, type MaskedInput } from "./io";

const SECRET = "lin_api_5eCr3t";
const BACKSPACE = "\u007f";
const CTRL_C = "\u0003";
const ENTER = "\r";
const TAB = "\u0009";

/** Feeds a whole keystroke sequence through the transform, one char at a time. */
function type(chars: string): MaskedInput {
  let state: MaskedInput = { value: "", echo: "", status: "typing" };
  for (const char of chars) state = pressKey(state, char);
  return state;
}

describe("masked input transform", () => {
  it("accumulates the typed value and echoes one asterisk per character", () => {
    const state = type(SECRET);

    expect(state.value).toBe(SECRET);
    expect(state.status).toBe("typing");
    expect(state.echo).toBe("*".repeat(SECRET.length));
  });

  it("never echoes a character of the typed value", () => {
    const state = type(`${SECRET}${ENTER}`);

    for (const char of new Set(SECRET)) {
      expect(state.echo).not.toContain(char);
    }
  });

  it("applies backspace to the value and erases the echoed asterisk", () => {
    const state = type(`abcd${BACKSPACE}${BACKSPACE}ef`);

    expect(state.value).toBe("abef");
    expect(state.echo).toBe("****\b \b\b \b**");
  });

  it("ignores backspace on an empty value", () => {
    const state = type(`${BACKSPACE}x`);

    expect(state.value).toBe("x");
    expect(state.echo).toBe("*");
  });

  it("completes on Enter and ends the echo with a newline", () => {
    const state = type(`secret${ENTER}`);

    expect(state.status).toBe("done");
    expect(state.value).toBe("secret");
    expect(state.echo).toBe("******\n");
  });

  it("completes on a line feed too", () => {
    expect(type("secret\n").status).toBe("done");
  });

  it("aborts on Ctrl-C without keeping the value", () => {
    const state = type(`secret${CTRL_C}`);

    expect(state.status).toBe("aborted");
    expect(state.value).toBe("");
    expect(state.echo).toBe("******\n");
  });

  it("ignores other control characters silently", () => {
    const state = type(`a${TAB}b`);

    expect(state.value).toBe("ab");
    expect(state.echo).toBe("**");
  });

  it("stops consuming keys once the line is done", () => {
    const state = type(`ab${ENTER}cd`);

    expect(state.value).toBe("ab");
    expect(state.echo).toBe("**\n");
  });
});

const LABEL = "Linear API key: ";

describe("readMasked", () => {
  it("resolves the typed value and writes only the label and asterisks", async () => {
    const input = new PassThrough();
    const echoed: string[] = [];

    const pending = readMasked(input, (s) => echoed.push(s), LABEL);
    input.write("lin_key");
    input.write(BACKSPACE);
    input.write(ENTER);

    await expect(pending).resolves.toBe("lin_ke");
    const written = echoed.join("");
    expect(written.startsWith(LABEL)).toBe(true);
    expect(written).not.toContain("lin_ke");
    expect(written.slice(LABEL.length)).toBe(`${"*".repeat(7)}\b \b\n`);
  });

  it("rejects on Ctrl-C", async () => {
    const input = new PassThrough();
    const pending = readMasked(input, () => undefined, LABEL);
    input.write("abc");
    input.write(CTRL_C);

    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("rejects when the stream ends before Enter", async () => {
    const input = new PassThrough();
    const pending = readMasked(input, () => undefined, LABEL);
    input.write("abc");
    input.end();

    await expect(pending).rejects.toThrow(/input ended/i);
  });
});
