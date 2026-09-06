import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE HASH CHAIN over the decision log (M4). Every line carries `prev`, the
 * sha256 of the line before it, byte for byte, without its newline; the
 * first line of the log carries `LOG_GENESIS`. A line changed, removed or
 * inserted anywhere breaks the `prev` of the line after it, and `verifyLog`
 * reports the first break by file and line.
 *
 * The chain runs ACROSS day files, in file-name order (ISO dates sort), so
 * the log is one chain, not one per day. The writer keeps no state: it
 * reads the log's last line back before every append (`lastLineHash`),
 * which is what lets a restarted proxy, or `missura approve` in its own
 * process, continue the chain rather than start one.
 *
 * KNOWN LIMIT, stated: two processes appending inside the same instant can
 * both read the same tail and fork the chain. The proxy is the one steady
 * writer and a human's decision is the other, at a human's rate; a fork is
 * something `verifyLog` reports, never something it hides.
 */

/** The `prev` of the very first line: a fixed constant, never a hash. */
export const LOG_GENESIS = "0".repeat(64);

const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function lineHash(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

/** The log's day files, oldest first. */
export function logFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => FILE_RE.test(name))
    .sort();
}

/** Enough to hold any line this writer produces; read again if it did not. */
const TAIL_BYTES = 64 * 1024;

/**
 * The last non-empty line of the file, read from its tail rather than from
 * its head: a day of decisions is megabytes, and the writer asks on every
 * event. `undefined` for an empty file.
 */
export function lastLine(path: string): string | undefined {
  const size = statSync(path).size;
  if (size === 0) return undefined;
  const fd = openSync(path, "r");
  try {
    let span = Math.min(size, TAIL_BYTES);
    for (;;) {
      const buffer = Buffer.alloc(span);
      readSync(fd, buffer, 0, span, size - span);
      const text = buffer.toString("utf8").replace(/\n+$/, "");
      const cut = text.lastIndexOf("\n");
      // A newline inside the window, or the whole file: the last line is whole.
      if (cut >= 0 || span === size) return text.slice(cut + 1);
      span = Math.min(size, span * 2);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * What the next line's `prev` must be, and which file it goes to: the
 * latest day file's last line — or genesis, and no file yet. An event is
 * always filed AFTER the log's last line, whatever its own timestamp says,
 * because the chain is one sequence: a line filed into an older day would
 * sit before lines it names as previous.
 */
export function chainHead(dir: string): { prev: string; latest: string | undefined } {
  const files = logFiles(dir);
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const file = files[i];
    if (file === undefined) continue;
    const line = lastLine(join(dir, file));
    if (line !== undefined) return { prev: lineHash(line), latest: file };
  }
  return { prev: LOG_GENESIS, latest: files.at(-1) };
}

export type LogVerdict =
  | { ok: true; events: number; files: number }
  | { ok: false; file: string; line: number; reason: string };

/** Walks the whole log, oldest file first, and stops at the first break. */
export function verifyLog(dir: string): LogVerdict {
  const files = logFiles(dir);
  let expected = LOG_GENESIS;
  let events = 0;
  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { ok: false, file, line: i + 1, reason: "line is not JSON" };
      }
      const prev = (parsed as { prev?: unknown }).prev;
      if (prev !== expected) {
        return {
          ok: false,
          file,
          line: i + 1,
          reason: `prev does not name the line before it (expected ${expected.slice(0, 12)}…)`,
        };
      }
      expected = lineHash(line);
      events += 1;
    }
  }
  return { ok: true, events, files: files.length };
}
