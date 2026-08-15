import {
  discoverGithubTargets,
  githubAssumptions,
  GITHUB_URL,
} from "./assume-github";
import { linearAssumptions, LINEAR_URL } from "./assume-linear";
import { discoverZendeskTargets, zendeskAssumptions } from "./assume-zendesk";
import {
  runOperation,
  type ExchangeContext,
  type Observation,
  type Operation,
  type VendorEndpoint,
} from "./exchange";
import {
  assumption,
  zendeskAuthHeader,
  zendeskBase,
  type Assumption,
  type Credentials,
} from "./harness";
import { WriteAttemptError } from "./http";
import { githubOperations } from "./ops-github";
import { discoverLinearTargets, linearOperations } from "./ops-linear";
import { zendeskOperations } from "./ops-zendesk";
import type { RunningProxy } from "./proxy";
import type { Vendor } from "./vendor-shapes";

/**
 * One connector's whole turn: discover what to aim at, check the assumptions it
 * encodes, then run every catalogued operation twice.
 *
 * A vendor that fails mid-section does not take the run down with it — the
 * remaining connectors still have something to prove and a partial report is
 * more useful than none. The single exception is a WRITE ATTEMPT: if any code
 * path in this suite tried to send something that is not a read, the run stops
 * where it stands, because the promise this suite makes to the human is that it
 * cannot change their data and a caught exception is not a promise.
 */

export interface Section {
  assumptions: Assumption[];
  observations: Observation[];
}

const EMPTY: Section = { assumptions: [], observations: [] };

function failedSection(vendor: Vendor, err: unknown): Section {
  return {
    assumptions: [
      assumption(
        {
          id: `${vendor}.section`,
          vendor,
          claim: "this connector's checks could run at all",
          encodedIn: "examples/compat/sections.ts",
        },
        "UNVERIFIABLE",
        `the section stopped: ${err instanceof Error ? err.message : String(err)}`,
      ),
    ],
    observations: [],
  };
}

async function runAll(
  operations: readonly Operation[],
  ctx: ExchangeContext,
): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const operation of operations) {
    out.push(await runOperation(operation, ctx));
  }
  return out;
}

/** Reruns a section's body, turning anything but a write attempt into a verdict. */
async function guarded(
  vendor: Vendor,
  body: () => Promise<Section>,
): Promise<Section> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof WriteAttemptError) throw err;
    return failedSection(vendor, err);
  }
}

export function linearSection(
  credentials: Credentials,
  proxy: RunningProxy,
): Promise<Section> {
  const credential = credentials.linear;
  if (credential === undefined) return Promise.resolve(EMPTY);
  return guarded("linear", async () => {
    const assumptions = await linearAssumptions(credential);
    const targets = await discoverLinearTargets(credential);
    const endpoint: VendorEndpoint = {
      base: LINEAR_URL.replace(/\/graphql$/, ""),
      headers: {
        authorization: credential.apiKey,
        "content-type": "application/json",
      },
    };
    return {
      assumptions,
      observations: await runAll(linearOperations(targets), {
        vendor: "linear",
        endpoint,
        origin: proxy.origins.linear,
        token: proxy.token,
        recorder: proxy.recorder,
      }),
    };
  });
}

export function githubSection(
  credentials: Credentials,
  proxy: RunningProxy,
): Promise<Section> {
  const credential = credentials.github;
  if (credential === undefined) return Promise.resolve(EMPTY);
  return guarded("github", async () => {
    const targets = await discoverGithubTargets(credential);
    const assumptions = await githubAssumptions(credential, targets);
    const endpoint: VendorEndpoint = {
      base: GITHUB_URL,
      headers: {
        authorization: `Bearer ${credential.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "missura-compat",
      },
    };
    return {
      assumptions,
      observations: await runAll(githubOperations(targets), {
        vendor: "github",
        endpoint,
        origin: proxy.origins.github,
        token: proxy.token,
        recorder: proxy.recorder,
      }),
    };
  });
}

export function zendeskSection(
  credentials: Credentials,
  proxy: RunningProxy,
): Promise<Section> {
  const credential = credentials.zendesk;
  if (credential === undefined) return Promise.resolve(EMPTY);
  const organizationId = credential.organizationIds[0];
  if (organizationId === undefined) {
    return Promise.resolve({
      assumptions: [
        assumption(
          {
            id: "zendesk.scope.organization",
            vendor: "zendesk",
            claim: "this run names at least one organization to scope by",
            encodedIn: "packages/connectors-zendesk/src/narrow.ts",
          },
          "UNVERIFIABLE",
          "set ZENDESK_ORGANIZATION_ID — a mission covering no organization reaches nothing, so there is nothing to compare",
        ),
      ],
      observations: [],
    });
  }
  return guarded("zendesk", async () => {
    const targets = await discoverZendeskTargets(credential, organizationId);
    const assumptions = await zendeskAssumptions(credential, targets);
    const endpoint: VendorEndpoint = {
      base: zendeskBase(credential),
      headers: {
        authorization: zendeskAuthHeader(credential),
        accept: "application/json",
      },
    };
    return {
      assumptions,
      observations: await runAll(zendeskOperations(targets), {
        vendor: "zendesk",
        endpoint,
        origin: proxy.origins.zendesk,
        token: proxy.token,
        recorder: proxy.recorder,
      }),
    };
  });
}
