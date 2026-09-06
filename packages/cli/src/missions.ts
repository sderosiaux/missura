import { existsSync } from "node:fs";
import {
  loadOrCreateKey,
  MissionStore,
  type MissionRecord,
  type MissionScope,
  type Operation,
} from "@missura/core";
import type { CliIo } from "./io";
import { resolveHome, type MissuraPaths } from "./paths";

/**
 * The mission store the operator's own commands share with `missura run`:
 * the same file, so a mission created by `exec` is revocable from another
 * terminal and a revoke is seen by a running proxy on its next request.
 *
 * `catalogue` is what a name-grant may name. The commands that never mint
 * leave it empty, which grants nothing — not a default, a refusal.
 */
export function openStore(
  paths: MissuraPaths,
  catalogue: readonly Operation[] = [],
): MissionStore {
  if (!existsSync(paths.signingKeyPath) || !existsSync(paths.vaultKeyPath)) {
    throw new Error("no signing key or vault key found — run missura init");
  }
  // The vault key seals approval bodies at rest (M3): the state file is
  // exactly as private as the credentials, under the one key.
  return new MissionStore(
    paths.missionsPath,
    {
      signing: loadOrCreateKey(paths.signingKeyPath),
      seal: loadOrCreateKey(paths.vaultKeyPath),
    },
    catalogue,
  );
}

export function formatScope(scope: MissionScope): string {
  const parts: string[] = [];
  if (scope.entity !== undefined) parts.push(scope.entity);
  if (scope.native !== undefined) {
    parts.push(`${scope.native.system}:${scope.native.id}`);
  }
  for (const repo of scope.repos ?? []) parts.push(repo);
  return parts.length === 0 ? "-" : parts.join(" ");
}

/** Whole minutes while there are any, then seconds — never a negative. */
export function formatTtl(secondsLeft: number): string {
  const left = Math.max(0, Math.floor(secondsLeft));
  return left >= 60 ? `${String(Math.floor(left / 60))}m` : `${String(left)}s`;
}

function row(record: MissionRecord, nowSeconds: number): string[] {
  return [
    record.id,
    record.purpose,
    record.actor,
    formatScope(record.scope),
    formatTtl(record.expiresAt - nowSeconds),
  ];
}

const HEADERS = ["ID", "PURPOSE", "ACTOR", "SCOPE", "TTL"];

function table(rows: string[][]): string[] {
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((r) => (r[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(HEADERS), ...rows.map(line)];
}

/**
 * Describes grants, never bears one: no token, no jti. `missura missions` is
 * the operator's read of who is holding what right now, and it must stay safe
 * to paste into a ticket.
 */
export function missionsCommand(io: CliIo): number {
  const store = openStore(resolveHome(io.env));
  const active = store.active();
  if (active.length === 0) {
    io.stdout("no active missions");
    return 0;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const line of table(active.map((m) => row(m, nowSeconds)))) {
    io.stdout(line);
  }
  return 0;
}

/**
 * Revocation is a local write to the shared state file, so it takes effect on
 * the proxy's very next request. An unknown id fails loudly here — unlike the
 * operator API, where silence is deliberate, a human typing an id wants to
 * know they typed it wrong.
 */
export function revokeCommand(io: CliIo, missionId: string | undefined): number {
  if (missionId === undefined || missionId.trim() === "") {
    throw new Error("missura revoke needs a mission id (see: missura missions)");
  }
  const record = openStore(resolveHome(io.env)).revoke(missionId.trim());
  io.stdout(`revoked ${record.id}`);
  return 0;
}
