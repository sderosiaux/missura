import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedScope } from "./entities";
import {
  MissionStore,
  type CreateMission,
  type MissionRecord,
} from "./missions";

const KEY = Buffer.alloc(32, 3);

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "missura-persist-")), "state.json");
}

const INPUT: CreateMission = {
  purpose: "aaaaa",
  actor: "sam@acme.io",
  scope: { customer: "acme", repos: ["acme-corp/product"] },
  ttlSeconds: 900,
};

const RESOLVED: ResolvedScope = {
  linearCustomerId: "c_18",
  githubRepos: [{ repo: "acme-corp/product" }],
};

/** A record of exactly the same serialized length, as another process would write. */
function twin(record: MissionRecord, purpose: string): MissionRecord {
  return {
    ...record,
    id: `msn_${"a".repeat(record.id.length - 4)}`,
    jti: record.jti.replace(/[0-9a-f]/g, "b"),
    purpose,
  };
}

/**
 * The freshness stamp (mtime + size) is a cheap read optimisation, never a
 * lock. Two processes minting at once read the same file, then both write the
 * whole of it back — and the second one silently erases the first one's
 * mission. The dropped mission's token still verifies (the signature is the
 * gate), so it keeps working while `missura revoke <id>` cannot find it.
 *
 * Pinned deterministically here: the file moves under the store without its
 * stamp moving, which is the interleave a race would produce by luck.
 */
describe("mission store — a write must not erase another writer's record", () => {
  it("keeps a record that appeared on disk since the last read", () => {
    const path = statePath();
    const mine = new MissionStore(path, KEY).create(INPUT, RESOLVED).record;
    // Whole milliseconds, so the test can put the file's clock back exactly
    // where the store under test last saw it.
    const pinned = new Date(Math.floor(statSync(path).mtimeMs));
    utimesSync(path, pinned, pinned);

    const store = new MissionStore(path, KEY);
    const before = statSync(path);
    writeFileSync(
      path,
      JSON.stringify({ missions: [twin(mine, "zzzzz")], revoked: [] }),
      "utf8",
    );
    utimesSync(path, pinned, pinned);
    // Same size by construction, same mtime by force: nothing the store polls
    // for has moved, and it is about to rewrite the whole file.
    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);

    store.create({ ...INPUT, purpose: "bbbbb" }, RESOLVED);

    const purposes = new MissionStore(path, KEY)
      .active()
      .map((m) => m.purpose)
      .sort();
    expect(purposes).toEqual(["aaaaa", "bbbbb", "zzzzz"]);
  });
});

/**
 * A revoke that answers "revoked" and does not revoke is worse than one that
 * errors: the operator stops looking. The operator API revokes by token, and a
 * signature-valid token whose record the store never saw — dropped by the race
 * above, or minted against another state file — used to swallow the throw and
 * answer `{revoked: true}` over a mission that stayed live.
 */
describe("mission store — revoking a jti with no record", () => {
  it("records the revocation anyway, and it survives a fresh store", () => {
    const path = statePath();
    const store = new MissionStore(path, KEY);
    const jti = "11111111-1111-4111-8111-111111111111";

    store.revokeJti(jti);

    expect(store.isRevoked(jti)).toBe(true);
    expect(new MissionStore(path, KEY).isRevoked(jti)).toBe(true);
  });

  it("revokes the matching record too when there is one", () => {
    const path = statePath();
    const store = new MissionStore(path, KEY);
    const { record } = store.create(INPUT, RESOLVED);

    store.revokeJti(record.jti);

    expect(store.isRevoked(record.jti)).toBe(true);
    expect(store.active()).toHaveLength(0);
    expect(new MissionStore(path, KEY).active()).toHaveLength(0);
  });

  it("is idempotent — a second revoke does not move the clock", () => {
    const path = statePath();
    const store = new MissionStore(path, KEY);
    const jti = "22222222-2222-4222-8222-222222222222";
    store.revokeJti(jti);
    const first = readFileSync(path, "utf8");
    store.revokeJti(jti);
    expect(readFileSync(path, "utf8")).toBe(first);
  });
});

describe("mission store — state file permissions", () => {
  it("tightens a state file that already exists with looser permissions", () => {
    const path = statePath();
    const store = new MissionStore(path, KEY);
    store.create(INPUT, RESOLVED);
    // `mode` on writeFileSync is honoured on creation only, so a file that got
    // loose permissions any other way would stay loose forever.
    chmodSync(path, 0o644);

    store.create({ ...INPUT, purpose: "second" }, RESOLVED);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
