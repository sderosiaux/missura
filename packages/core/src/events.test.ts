import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, formatEventLine, type DecisionEvent } from "./events";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "missura-events-"));
}

const EVENT: DecisionEvent = {
  ts: "2026-08-14T10:00:00.000Z",
  provider: "linear",
  operation: "IssuesQuery",
  action: "read",
  decision: "allow",
  reason: "cataloged",
  missionId: "msn_dev",
  latencyMs: 42,
};

describe("decision events", () => {
  it("appends a parseable JSONL line", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0] ?? ""), "utf8")
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(EVENT);
  });

  it("appends successive events to the same day file", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    appendEvent(dir, { ...EVENT, decision: "deny", reason: "mutation" });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0] ?? ""), "utf8")
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1] ?? "") as DecisionEvent).decision).toBe("deny");
  });

  it("names the file after the event day", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    expect(readdirSync(dir)[0]).toBe("2026-08-14.jsonl");
  });

  it("writes one file per day", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    appendEvent(dir, { ...EVENT, ts: "2026-08-15T01:02:03.000Z" });
    expect(readdirSync(dir).sort()).toEqual([
      "2026-08-14.jsonl",
      "2026-08-15.jsonl",
    ]);
  });

  it("serializes only whitelisted fields — extra properties never reach disk", () => {
    const dir = tmpDir();
    const leaky = {
      ...EVENT,
      token: "msr_supersecret",
      authorization: "Bearer lin_api_secret",
      body: '{"query":"..."}',
      headers: { cookie: "session=1" },
    } as DecisionEvent;
    appendEvent(dir, leaky);
    const raw = readFileSync(join(dir, "2026-08-14.jsonl"), "utf8");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("authorization");
    expect(raw).not.toContain("body");
    expect(raw).not.toContain("supersecret");
    expect(raw).not.toContain("lin_api_secret");
    expect(JSON.parse(raw.trimEnd())).toEqual(EVENT);
  });

  it("serializes exactly the whitelisted key set", () => {
    const dir = tmpDir();
    appendEvent(dir, { ...EVENT, latencyMs: 7 });
    const parsed = JSON.parse(
      readFileSync(join(dir, "2026-08-14.jsonl"), "utf8").trimEnd(),
    ) as DecisionEvent;
    expect(Object.keys(parsed).sort()).toEqual([
      "action",
      "decision",
      "latencyMs",
      "missionId",
      "operation",
      "provider",
      "reason",
      "ts",
    ]);
  });

  it("serializes provenance: actor, purpose and traceId", () => {
    const dir = tmpDir();
    appendEvent(dir, {
      ...EVENT,
      actor: "ops@local",
      purpose: "support case 42",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    const parsed = JSON.parse(
      readFileSync(join(dir, "2026-08-14.jsonl"), "utf8").trimEnd(),
    ) as DecisionEvent;

    expect(parsed.actor).toBe("ops@local");
    expect(parsed.purpose).toBe("support case 42");
    expect(parsed.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("omits provenance keys entirely when the claims carry none", () => {
    const dir = tmpDir();
    appendEvent(dir, EVENT);
    const raw = readFileSync(join(dir, "2026-08-14.jsonl"), "utf8");

    expect(raw).not.toContain("actor");
    expect(raw).not.toContain("purpose");
    expect(raw).not.toContain("traceId");
  });

  it("creates the log directory when missing", () => {
    const dir = join(tmpDir(), "nested", "events");
    appendEvent(dir, EVENT);
    expect(readdirSync(dir)).toEqual(["2026-08-14.jsonl"]);
  });

  it("formats a line with uppercase decision, provider and operation", () => {
    const line = formatEventLine(EVENT);
    expect(line).toContain("ALLOW");
    expect(line).toContain("linear");
    expect(line).toContain("IssuesQuery");
  });

  it("formats denials with the reason", () => {
    const line = formatEventLine({
      ...EVENT,
      decision: "deny",
      reason: "mutation not allowed",
    });
    expect(line).toContain("DENY");
    expect(line).toContain("mutation not allowed");
  });

  it("never formats secret-bearing extra properties", () => {
    const line = formatEventLine({
      ...EVENT,
      token: "msr_supersecret",
    } as DecisionEvent);
    expect(line).not.toContain("supersecret");
  });
});
