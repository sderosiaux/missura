import { createServer, type Server } from "node:http";
import { decideGithub, GITHUB_OPERATIONS } from "@missura/connectors-github";
import { decideLinear, LINEAR_OPERATIONS } from "@missura/connectors-linear";
import { decideZendesk, ZENDESK_OPERATIONS } from "@missura/connectors-zendesk";
import {
  createCursorStore,
  createParentProofStore,
  verifyMissionToken,
  type CatalogDecision,
  type DecisionEvent,
  type MissionScope,
  type Operation,
  type Provider,
  type ResolvedScope,
} from "@missura/core";
import { NO_APPROVALS, type ApprovalStore } from "./approvals";
import { listener, MAX_BODY_BYTES } from "./listener";
import type { NarrowFn } from "./narrow";
import type { OperationsDeps } from "./operations";
import type { PipelineDeps } from "./pipeline";

export const DEFAULT_LINEAR_PORT = 8481;
export const DEFAULT_GITHUB_PORT = 8482;
export const DEFAULT_ZENDESK_PORT = 8483;
export const DEFAULT_LINEAR_UPSTREAM = "https://api.linear.app";
export const DEFAULT_GITHUB_UPSTREAM = "https://api.github.com";
export { MAX_BODY_BYTES };

export interface ConnectionConfig {
  /** Built from the vault once at boot; it never travels back to the agent. */
  vendorAuthHeader: string;
  port?: number;
  upstreamBase?: string;
  /**
   * The connector's NARROW. Required: a connection wired without one would
   * pass every cataloged request through unnarrowed, and a missing policy
   * input must never read as PASS. A connection that genuinely narrows nothing
   * says so out loud, with `passThroughNarrow`.
   */
  narrow: NarrowFn;
}

/**
 * A Zendesk connection, which owes one thing more than the others: its origin.
 *
 * Every account lives at its own `https://<subdomain>.zendesk.com`, so there is
 * no default that is not a guess at somebody else's tenant — and a proxy that
 * guessed would inject this account's credential into it. Required, therefore,
 * rather than defaulted.
 */
export interface ZendeskConnectionConfig extends ConnectionConfig {
  upstreamBase: string;
}

export interface ProxyConfig {
  signingKey: Buffer;
  emit(ev: DecisionEvent): void;
  /**
   * The mission store's revocation list. Required: defaulting it to "nothing
   * is revoked" would turn a wiring mistake into a proxy that honours every
   * called-back mission until expiry.
   */
  isRevoked: (jti: string) => boolean;
  linear: ConnectionConfig;
  github: ConnectionConfig;
  /**
   * Optional, and the one connection that is: a Zendesk connection needs an
   * account's own origin and its own credential, so an operator who configured
   * neither gets no listener rather than one aimed at nothing. Absent means
   * "this proxy serves no Zendesk", never "Zendesk passes through".
   */
  zendesk?: ZendeskConnectionConfig;
  /**
   * What running operations needs beyond the connectors' own pipelines: the
   * mission's scope resolved to targets, for a plan to pick them from. The
   * same resolver the connectors' NARROW is wired with, so a plan and the
   * check on its steps read one graph.
   *
   * Absent means this proxy serves no operations — introspection lists none
   * and the route refuses every name — never "operations run unscoped".
   */
  operations?: {
    resolveScope(scope: MissionScope): ResolvedScope | undefined;
    /** The mission store, for the gated writes to be written down on (M10). */
    approvals: ApprovalStore;
  };
  /** Overridable so tests can drive an in-process vendor double. */
  fetchImpl?: typeof fetch;
}

export interface ProxyServers {
  linear: Server;
  github: Server;
  /** Present exactly when `ProxyConfig.zendesk` was. */
  zendesk?: Server;
  close(): Promise<void>;
}


/**
 * The operations a proxy with these connections can run: each connector's
 * own, for the connectors that have a listener. A Zendesk operation on a
 * proxy without a Zendesk connection is not "unavailable to this mission" —
 * it does not exist here. Exported so a mint validates a name-grant against
 * the same list the proxy serves (`MissionStore`).
 */
export function operationCatalogue(connections: {
  zendesk: boolean;
}): readonly Operation[] {
  return [
    ...LINEAR_OPERATIONS,
    ...GITHUB_OPERATIONS,
    ...(connections.zendesk ? ZENDESK_OPERATIONS : []),
  ];
}

/**
 * Every operation the product knows, whether or not this deployment serves
 * it. The gap report (M9) is computed over this one: an operation on a
 * system nobody connected is a gap with a cause, not a name nobody knows.
 */
export const ALL_OPERATIONS: readonly Operation[] = operationCatalogue({ zendesk: true });

function catalogueFor(config: ProxyConfig): readonly Operation[] {
  if (config.operations === undefined) return [];
  return operationCatalogue({ zendesk: config.zendesk !== undefined });
}

/**
 * One `OperationsDeps` shared by every listener, over a registry the listeners
 * are added to as they are built: an operation's inner calls run on the
 * connector's OWN pipeline — its catalog, its NARROW, its credential — and not
 * on the one the agent happened to aim at.
 */
function operationsFor(
  config: ProxyConfig,
  pipelines: ReadonlyMap<Provider, PipelineDeps>,
): OperationsDeps {
  return {
    catalogue: catalogueFor(config),
    resolveScope: (scope): ResolvedScope | undefined =>
      config.operations?.resolveScope(scope),
    pipelineFor: (connector): PipelineDeps | undefined =>
      pipelines.get(connector),
    approvals: config.operations?.approvals ?? NO_APPROVALS,
  };
}

function deps(
  provider: Provider,
  config: ProxyConfig,
  connection: ConnectionConfig,
  decide: PipelineDeps["decide"],
  defaultUpstream: string,
  operations: OperationsDeps,
): PipelineDeps {
  return {
    provider,
    // One store per connection: a cursor is a position in ONE vendor's
    // collection, and a handle that crossed connections would name a position
    // in a collection the other vendor never has.
    cursors: createCursorStore(),
    // One store per connection too: a proof key is an object in ONE vendor's
    // namespace, and `ticket:1` under two vendors is two different objects.
    proofs: createParentProofStore(),
    verifyToken: (token) =>
      verifyMissionToken(token, { key: config.signingKey }),
    decide,
    isRevoked: config.isRevoked,
    narrow: connection.narrow,
    vendorAuthHeader: (): string => connection.vendorAuthHeader,
    upstreamBase: connection.upstreamBase ?? defaultUpstream,
    fetchImpl: config.fetchImpl ?? fetch,
    emit: (ev): void => {
      config.emit(ev);
    },
    operations,
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

/**
 * One listener per connector: an agent points a vendor SDK at a port and gets
 * that vendor's catalog, its credential and nothing else. Separate ports are
 * an addressing convenience, not the boundary — a token aimed at the wrong
 * port is refused by the pipeline's `claims.connections` check, which is what
 * actually stops the replay.
 */
export async function createServers(
  config: ProxyConfig,
): Promise<ProxyServers> {
  const pipelines = new Map<Provider, PipelineDeps>();
  const operations = operationsFor(config, pipelines);
  const register = (provider: Provider, built: PipelineDeps): PipelineDeps => {
    pipelines.set(provider, built);
    return built;
  };
  const linear = createServer(
    listener(
      register(
        "linear",
        deps(
          "linear",
          config,
          config.linear,
          (req): CatalogDecision =>
            decideLinear(req.method, req.path, req.body),
          DEFAULT_LINEAR_UPSTREAM,
          operations,
        ),
      ),
    ),
  );
  const github = createServer(
    listener(
      register(
        "github",
        deps(
          "github",
          config,
          config.github,
          // The origin travels: the one write route opens only under `via`,
          // which the executor sets in-process and the listener never does.
          (req): CatalogDecision => decideGithub(req.method, req.path, req.via),
          DEFAULT_GITHUB_UPSTREAM,
          operations,
        ),
      ),
    ),
  );
  const zendeskConfig = config.zendesk;
  const zendesk =
    zendeskConfig === undefined
      ? undefined
      : createServer(
          listener(
            register(
              "zendesk",
              deps(
                "zendesk",
                config,
                zendeskConfig,
                // The origin travels here too: the one Zendesk write opens
                // only under `via` (M10), which the listener never sets.
                (req): CatalogDecision => decideZendesk(req.method, req.path, req.via),
                zendeskConfig.upstreamBase,
                operations,
              ),
            ),
          ),
        );

  // Started in order, and every failure takes down what is already up: a proxy
  // half-listening would serve one vendor while an operator believed all of
  // them were bound.
  const started: Server[] = [];
  try {
    await listen(linear, config.linear.port ?? DEFAULT_LINEAR_PORT);
    started.push(linear);
    await listen(github, config.github.port ?? DEFAULT_GITHUB_PORT);
    started.push(github);
    if (zendesk !== undefined && zendeskConfig !== undefined) {
      await listen(zendesk, zendeskConfig.port ?? DEFAULT_ZENDESK_PORT);
      started.push(zendesk);
    }
  } catch (err) {
    await Promise.all(started.map(shutdown));
    throw err;
  }

  return {
    linear,
    github,
    ...(zendesk === undefined ? {} : { zendesk }),
    close: async (): Promise<void> => {
      await Promise.all(started.map(shutdown));
    },
  };
}
