import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  appendEvent,
  formatEventLine,
  loadOrCreateKey,
  loadVault,
  verifyMissionToken,
  type VaultData,
} from "@missura/core";
import {
  createServers,
  DEFAULT_OPERATOR_PORT,
  startOperatorServer,
  type NarrowFn,
  type ProxyServers,
  type ZendeskConnectionConfig,
} from "@missura/proxy";
import { ZENDESK_BASE, ZENDESK_CREDENTIAL } from "./init-zendesk";
import type { CliIo } from "./io";
import { openStore } from "./missions";
import {
  githubNarrow,
  linearNarrow,
  scopeForOperations,
  scopeResolver,
  zendeskNarrow,
  type Resolver,
} from "./narrow-wiring";
import { resolveHome, type MissuraPaths } from "./paths";

export interface RunOptions {
  linearPort?: number;
  githubPort?: number;
  zendeskPort?: number;
  operatorPort?: number;
  entitiesPath?: string;
  /** Overridable so a test can drive an in-process vendor double. */
  fetchImpl?: typeof fetch;
}

/** The two data planes plus the operator plane, shut down together. */
export interface RunningProxy extends ProxyServers {
  operator: Server;
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

function origin(server: Server): string {
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/**
 * The third connection, or nothing at all. It needs BOTH halves — an origin
 * and a credential — and `missura init` writes them together, so half of one
 * here means a vault somebody edited by hand. Refused rather than defaulted:
 * a guessed origin is a guess at another tenant, and the credential would go
 * with it.
 */
function zendeskConnection(
  vault: VaultData,
  narrow: NarrowFn,
  port: number | undefined,
): ZendeskConnectionConfig | undefined {
  const authorization = vault[ZENDESK_CREDENTIAL];
  const upstreamBase = vault[ZENDESK_BASE];
  if (
    (authorization ?? "").length === 0 &&
    (upstreamBase ?? "").length === 0
  ) {
    return undefined;
  }
  if (
    authorization === undefined ||
    authorization.length === 0 ||
    upstreamBase === undefined ||
    upstreamBase.length === 0
  ) {
    throw new Error(
      "vault holds half a zendesk connection — run missura init again",
    );
  }
  return {
    vendorAuthHeader: authorization,
    upstreamBase,
    narrow,
    ...(port === undefined ? {} : { port }),
  };
}

/**
 * Boots the two connector listeners with the vendor credentials taken from the
 * vault once, here — they live in the proxy process only — and the operator
 * plane beside them, on its own port.
 *
 * The three share one mission store and one entity graph: a mission minted on
 * 8480 is enforced by the data planes, and a revoke lands on the very next
 * request because `isRevoked` reads that same store rather than a cache.
 *
 * The graph is read once at boot; a mission's scope is resolved per
 * request from its own claims, so no vendor identifier ever travels in a token.
 */
export async function runCommand(
  io: CliIo,
  options: RunOptions = {},
): Promise<RunningProxy> {
  const paths = resolveHome(io.env);
  const vault = openVault(paths);
  const signingKey = loadOrCreateKey(paths.signingKeyPath);
  const store = openStore(paths);
  const resolve: Resolver = scopeResolver(
    options.entitiesPath ?? paths.entitiesPath,
  );

  const zendesk = zendeskConnection(
    vault,
    zendeskNarrow(resolve),
    options.zendeskPort,
  );
  const servers = await createServers({
    signingKey,
    isRevoked: (jti: string): boolean => store.isRevoked(jti),
    emit: (ev): void => {
      appendEvent(paths.eventsDir, ev);
      io.stdout(formatEventLine(ev));
    },
    linear: {
      vendorAuthHeader: credential(vault, "linear"),
      narrow: linearNarrow(resolve),
      ...(options.linearPort === undefined ? {} : { port: options.linearPort }),
    },
    github: {
      vendorAuthHeader: `Bearer ${credential(vault, "github")}`,
      narrow: githubNarrow(resolve),
      ...(options.githubPort === undefined ? {} : { port: options.githubPort }),
    },
    ...(zendesk === undefined ? {} : { zendesk }),
    // Operations plan from the resolver the NARROWs enforce with: one graph,
    // one reading of it.
    operations: { resolveScope: scopeForOperations(resolve) },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  let operator: Server;
  try {
    operator = await startOperatorServer(
      {
        store,
        resolve,
        operatorKey: loadOrCreateKey(paths.operatorKeyPath),
        verifyToken: (token: string) =>
          verifyMissionToken(token, { key: signingKey }),
        // The ports actually bound, not the defaults: a `--linear-port 0` boot
        // must still hand the agent an origin it can reach. Zendesk appears
        // exactly when a listener does — an origin for a connection that is not
        // there would send the agent at a closed port.
        proxyOrigins: {
          linear: origin(servers.linear),
          github: origin(servers.github),
          ...(servers.zendesk === undefined
            ? {}
            : { zendesk: origin(servers.zendesk) }),
        },
      },
      options.operatorPort ?? DEFAULT_OPERATOR_PORT,
    );
  } catch (err) {
    await servers.close();
    throw err;
  }

  io.stdout(`linear    ${origin(servers.linear)}`);
  io.stdout(`github    ${origin(servers.github)}`);
  if (servers.zendesk !== undefined) {
    io.stdout(`zendesk   ${origin(servers.zendesk)}`);
  }
  io.stdout(`operator  ${origin(operator)}`);
  io.stdout(`events    ${paths.eventsDir}`);

  return {
    linear: servers.linear,
    github: servers.github,
    ...(servers.zendesk === undefined ? {} : { zendesk: servers.zendesk }),
    operator,
    close: async (): Promise<void> => {
      await Promise.all([
        servers.close(),
        new Promise<void>((done) => {
          operator.close(() => {
            done();
          });
          operator.closeAllConnections();
        }),
      ]);
    },
  };
}
