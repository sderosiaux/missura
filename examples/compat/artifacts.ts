import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationSpec } from "./classify";
import type { Observation } from "./exchange";
import type { Assumption } from "./harness";
import {
  buildManifest,
  serializeManifest,
  type CoverageManifest,
} from "./manifest";
import { githubOperations } from "./ops-github";
import { linearOperations } from "./ops-linear";
import { zendeskOperations } from "./ops-zendesk";
import type { Vendor } from "./vendor-shapes";

/**
 * Where the two deliverables land, and what the manifest's operation list is
 * built from.
 *
 * The list is built from PLACEHOLDER targets — `{org}`, `{owner}/{repo}`,
 * `{customer}` — rather than from a run. Two reasons, and the second is the one
 * that matters: a manifest built from a run would be missing whatever that run
 * could not aim at, so a repository with no pull requests would silently ship a
 * manifest that never mentions `repos.pulls.get`; and a manifest that can be
 * generated with no credentials at all can be committed, reviewed and diffed by
 * someone who will never run the live suite.
 */

export const MANIFEST_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "manifests",
);

const PLACEHOLDERS = {
  zendesk: {
    organizationId: "{org}",
    ticketId: "{ticket}",
    userId: "{user}",
  },
  github: {
    repo: "{owner}/{repo}",
    issueNumber: "{number}",
    pullNumber: "{number}",
    nestedPath: "{dir}/{file}",
  },
  linear: { customerId: "{customer}", issueId: "{issue}" },
} as const;

/** Every operation each connector has an opinion about, ids left unbound. */
export function catalogueSpecs(): Record<Vendor, OperationSpec[]> {
  return {
    linear: linearOperations(PLACEHOLDERS.linear).map((op) => op.spec),
    github: githubOperations(PLACEHOLDERS.github).map((op) => op.spec),
    zendesk: zendeskOperations(PLACEHOLDERS.zendesk).map((op) => op.spec),
  };
}

export function manifests(
  observations: readonly Observation[],
  assumptions: readonly Assumption[],
): CoverageManifest[] {
  const specs = catalogueSpecs();
  return (Object.keys(specs) as Vendor[]).map((vendor) =>
    buildManifest(
      vendor,
      specs[vendor],
      observations.filter((entry) => entry.vendor === vendor),
      assumptions,
    ),
  );
}

/** Writes one manifest per connector plus the report, and says where they went. */
export function writeArtifacts(
  built: readonly CoverageManifest[],
  report: string,
): string[] {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const written: string[] = [];
  for (const manifest of built) {
    const path = join(MANIFEST_DIR, `${manifest.connector}.json`);
    writeFileSync(path, serializeManifest(manifest), "utf8");
    written.push(path);
  }
  const reportPath = join(MANIFEST_DIR, "report.md");
  writeFileSync(reportPath, report, "utf8");
  written.push(reportPath);
  return written;
}
