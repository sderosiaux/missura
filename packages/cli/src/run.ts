import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  appendEvent,
  formatEventLine,
  loadOrCreateKey,
  loadVault,
  type VaultData,
} from "@missura/core";
import { createServers, type ProxyServers } from "@missura/proxy";
import type { CliIo } from "./io";
import { resolveHome, type MissuraPaths } from "./paths";

export interface RunOptions {
  linearPort?: number;
  githubPort?: number;
}

function credential(vault: VaultData, connection: string): string {
  const value = vault[connection];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `vault has no ${connection} credential — run missura init again`,
    );
  }
  return value;
}

function openVault(paths: MissuraPaths): VaultData {
  if (!existsSync(paths.vaultPath)) {
    throw new Error("vault not found — run missura init");
  }
  return loadVault(paths.vaultPath, loadOrCreateKey(paths.vaultKeyPath));
}

function port(server: Server): string {
  return String((server.address() as AddressInfo).port);
}

/**
 * Boots one listener per connector with the vendor credentials taken from the
 * vault once, here. They live in the proxy process only: nothing downstream of
 * this function — event, log line or error payload — can carry them.
 *
 * Vendor auth shapes differ and are not interchangeable: Linear expects the
 * raw API key as the `Authorization` value, GitHub expects `Bearer <token>`.
 */
export async function runCommand(
  io: CliIo,
  options: RunOptions = {},
): Promise<ProxyServers> {
  const paths = resolveHome(io.env);
  const vault = openVault(paths);

  const servers = await createServers({
    signingKey: loadOrCreateKey(paths.signingKeyPath),
    emit: (ev): void => {
      appendEvent(paths.eventsDir, ev);
      io.stdout(formatEventLine(ev));
    },
    linear: {
      vendorAuthHeader: credential(vault, "linear"),
      ...(options.linearPort === undefined ? {} : { port: options.linearPort }),
    },
    github: {
      vendorAuthHeader: `Bearer ${credential(vault, "github")}`,
      ...(options.githubPort === undefined ? {} : { port: options.githubPort }),
    },
  });

  io.stdout(`linear  http://127.0.0.1:${port(servers.linear)}`);
  io.stdout(`github  http://127.0.0.1:${port(servers.github)}`);
  io.stdout(`events  ${paths.eventsDir}`);
  return servers;
}
