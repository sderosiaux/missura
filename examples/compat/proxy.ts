import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { narrowGithub } from "@missura/connectors-github";
import { narrowLinear } from "@missura/connectors-linear";
import { narrowZendesk } from "@missura/connectors-zendesk";
import { signMissionToken, type DecisionEvent } from "@missura/core";
import {
  createServers,
  type NarrowFn,
  type NarrowResult,
  type ProxyServers,
} from "@missura/proxy";
import {
  zendeskAuthHeader,
  zendeskBase,
  type Credentials,
  type Skips,
} from "./harness";
import { createRecorder, type Recorder } from "./upstream";
import type { Vendor } from "./vendor-shapes";

/**
 * The proxy under test, booted IN-PROCESS.
 *
 * No vault, no CLI, no `missura run`: `createServers` is the seam the CLI
 * itself uses, so half B measures the shipped pipeline rather than a rehearsal
 * of it. Two things are wired differently from production, both on purpose and
 * both stated here rather than discovered later:
 *
 *   - the mission's SCOPE is resolved from the environment, not from
 *     `entities.json`. The suite must run without `missura init`, and the
 *     direct half needs those same vendor ids anyway;
 *   - a connector with no credential is still given a listener, because
 *     `createServers` requires linear and github. It is given a NARROW that
 *     denies everything and a credential that is the empty string, and the
 *     minted mission does not carry its connection — so its listener refuses at
 *     the connection check, before any of that could matter.
 */

const TTL_SECONDS = 1800;
const EPHEMERAL = 0;

export interface RunningProxy {
  servers: ProxyServers;
  /** The mission token half B presents, minted for this run only. */
  token: string;
  /** `http://127.0.0.1:<port>` per connection actually bound. */
  origins: Record<Vendor, string>;
  /** What the proxy sent the vendor, per exchange. */
  recorder: Recorder;
  /** Decisions the pipeline emitted, in order — the audit trail of this run. */
  events: DecisionEvent[];
  close(): Promise<void>;
}

const DENY_NO_CREDENTIAL: NarrowFn = () => ({
  decision: "deny",
  reason: "this run has no credential for that connector",
});

function origin(server: Server): string {
  const address = server.address() as AddressInfo | null;
  return `http://127.0.0.1:${String(address?.port ?? 0)}`;
}

/**
 * Each connector's NARROW, closed over the scope this run resolved. The bodies
 * are the shipped ones — `@missura/connectors-*` — so nothing here can make a
 * connector look better than it is.
 */
function narrows(credentials: Credentials): Record<Vendor, NarrowFn> {
  const linear = credentials.linear;
  const github = credentials.github;
  const zendesk = credentials.zendesk;
  return {
    linear:
      linear === undefined
        ? DENY_NO_CREDENTIAL
        : (req): NarrowResult =>
            narrowLinear(req.body, { linearCustomerId: linear.customerId }),
    github:
      github === undefined
        ? DENY_NO_CREDENTIAL
        : (req): NarrowResult =>
            narrowGithub(req.path, { githubRepos: [github.repo] }),
    zendesk:
      zendesk === undefined
        ? DENY_NO_CREDENTIAL
        : (req): NarrowResult =>
            narrowZendesk(req.path, {
              zendeskOrganizationIds: [...zendesk.organizationIds],
            }),
  };
}

/** The connections this run can actually exercise — the rest are skipped. */
export function connectionsOf(credentials: Credentials): Vendor[] {
  const out: Vendor[] = [];
  if (credentials.linear !== undefined) out.push("linear");
  if (credentials.github !== undefined) out.push("github");
  if (credentials.zendesk !== undefined) out.push("zendesk");
  return out;
}

/**
 * One mission for the whole run, minted here because there is no operator to
 * ask. It carries only what this suite exercises: the connections whose
 * credentials are present, and `read`/`search` — the same two capabilities
 * `MissionStore.create` grants, spelled out rather than imported so a change
 * to the store's grant shows up here as a compile-time nothing and a live
 * difference, which is what a compatibility suite is for.
 */
export function mintMission(
  signingKey: Buffer,
  credentials: Credentials,
): string {
  const github = credentials.github;
  return signMissionToken(
    {
      id: `msn_compat_${randomBytes(4).toString("hex")}`,
      purpose: "compatibility suite — direct vs proxied, read-only",
      actor: "compat@local",
      scope: {
        customer: "compat",
        ...(github === undefined ? {} : { repos: [github.repo] }),
      },
      connections: connectionsOf(credentials),
      allow: ["read", "search"],
    },
    { key: signingKey, ttlSeconds: TTL_SECONDS },
  );
}

export async function bootProxy(
  credentials: Credentials,
  announce: (line: string) => void,
): Promise<RunningProxy> {
  const signingKey = randomBytes(32);
  const recorder = createRecorder(announce);
  const events: DecisionEvent[] = [];
  const narrow = narrows(credentials);
  const zendesk = credentials.zendesk;

  const servers = await createServers({
    signingKey,
    isRevoked: (): boolean => false,
    emit: (ev): void => {
      events.push(ev);
    },
    fetchImpl: recorder.fetchImpl,
    linear: {
      vendorAuthHeader: credentials.linear?.apiKey ?? "",
      narrow: narrow.linear,
      port: EPHEMERAL,
    },
    github: {
      vendorAuthHeader:
        credentials.github === undefined
          ? ""
          : `Bearer ${credentials.github.token}`,
      narrow: narrow.github,
      port: EPHEMERAL,
    },
    ...(zendesk === undefined
      ? {}
      : {
          zendesk: {
            vendorAuthHeader: zendeskAuthHeader(zendesk),
            narrow: narrow.zendesk,
            upstreamBase: zendeskBase(zendesk),
            port: EPHEMERAL,
          },
        }),
  });

  return {
    servers,
    token: mintMission(signingKey, credentials),
    origins: {
      linear: origin(servers.linear),
      github: origin(servers.github),
      zendesk: servers.zendesk === undefined ? "" : origin(servers.zendesk),
    },
    recorder,
    events,
    close: (): Promise<void> => servers.close(),
  };
}

/** Why a vendor's whole section is being skipped, printed once, per vendor. */
export function skipLine(vendor: Vendor, skips: Skips): string | undefined {
  const reason = skips[vendor];
  return reason === undefined ? undefined : `SKIP          ${vendor} — ${reason}`;
}
