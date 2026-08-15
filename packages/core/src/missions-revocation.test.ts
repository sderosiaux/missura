import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MissionStore, type CreateMission } from "./missions";

const KEY = Buffer.alloc(32, 3);
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(SRC_DIR, "..");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "missura-revocation-"));
}

function statePath(): string {
  return join(tmp(), "state.json");
}

const INPUT: CreateMission = {
  purpose: "support case 482",
  actor: "sam@acme.io",
  scope: { customer: "acme", repos: ["acme-corp/product"] },
  ttlSeconds: 900,
};

/**
 * A whole other process, holding its own `MissionStore` over the same file —
 * exactly what `missura revoke` is to a running `missura run`.
 */
function revokeInChildProcess(stateFile: string, missionId: string): void {
  const script = join(tmp(), "revoke.ts");
  writeFileSync(
    script,
    [
      `import { MissionStore } from ${JSON.stringify(join(SRC_DIR, "missions.ts"))};`,
      `const store = new MissionStore(${JSON.stringify(stateFile)}, Buffer.alloc(32, 3));`,
      `store.revoke(${JSON.stringify(missionId)});`,
    ].join("\n"),
    "utf8",
  );
  const out = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (out.status !== 0) {
    throw new Error(`child revoke failed: ${out.stderr}`);
  }
}

describe("mission store — revocation across instances", () => {
  it("sees a revoke written by another instance, without being reconstructed", () => {
    const path = statePath();
    const writer = new MissionStore(path, KEY);
    const { record } = writer.create(INPUT);

    // Constructed BEFORE the revoke: this is the proxy, booted and holding the
    // store it captured at startup.
    const proxy = new MissionStore(path, KEY);
    expect(proxy.isRevoked(record.jti)).toBe(false);

    writer.revoke(record.id);

    expect(proxy.isRevoked(record.jti)).toBe(true);
    expect(proxy.active()).toHaveLength(0);
  });

  it("sees a revoke written by a separate process", () => {
    const path = statePath();
    const proxy = new MissionStore(path, KEY);
    const { record } = proxy.create(INPUT);
    expect(proxy.isRevoked(record.jti)).toBe(false);

    revokeInChildProcess(path, record.id);

    expect(proxy.isRevoked(record.jti)).toBe(true);
  }, 30_000);

  it("keeps a mission it has never seen written by another process", () => {
    const path = statePath();
    const first = new MissionStore(path, KEY);
    first.create(INPUT);
    const proxy = new MissionStore(path, KEY);

    const second = new MissionStore(path, KEY);
    const { record } = second.create({ ...INPUT, purpose: "second" });

    expect(proxy.isRevoked(record.jti)).toBe(false);
    expect(proxy.active().map((m) => m.purpose)).toEqual([
      "support case 482",
      "second",
    ]);
  });

  it("never downgrades a revocation it already knows about", () => {
    const path = statePath();
    const proxy = new MissionStore(path, KEY);
    const { record } = proxy.create(INPUT);
    new MissionStore(path, KEY).revoke(record.id);
    expect(proxy.isRevoked(record.jti)).toBe(true);

    // The state file is rolled back to a version that predates the revoke —
    // a restored backup, or a writer that never saw it. A revocation this
    // process has already observed is not undone by a re-read.
    writeFileSync(
      path,
      JSON.stringify({ missions: [{ ...record, revokedAt: undefined }] }),
      "utf8",
    );

    expect(proxy.isRevoked(record.jti)).toBe(true);
    expect(proxy.active()).toHaveLength(0);
  });

  it("keeps the last known-good view when the state file goes unreadable", () => {
    const path = statePath();
    const proxy = new MissionStore(path, KEY);
    const revoked = proxy.create(INPUT).record;
    const live = proxy.create({ ...INPUT, purpose: "still live" }).record;
    new MissionStore(path, KEY).revoke(revoked.id);
    expect(proxy.isRevoked(revoked.jti)).toBe(true);

    writeFileSync(path, "{ not json at all", "utf8");

    // Signature and expiry stay the gate for everything else; the known
    // revocation is not silently downgraded.
    expect(proxy.isRevoked(revoked.jti)).toBe(true);
    expect(proxy.isRevoked(live.jti)).toBe(false);
    expect(proxy.active().map((m) => m.id)).toEqual([live.id]);
  });
});
