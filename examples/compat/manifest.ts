import type { Classification, OperationSpec } from "./classify";
import type { Observation } from "./exchange";
import type { Assumption } from "./harness";
import type { Vendor } from "./vendor-shapes";
import { assertWritable, scrub } from "./writable";

/**
 * THE COVERAGE MANIFEST (PRD F-014) — one per connector, machine-readable, and
 * a deliverable in its own right rather than a by-product of a run.
 *
 * It answers, for every operation the connector has an opinion about: is it
 * served, what is narrowed on the way in, what is filtered on the way out, what
 * is refused outright — and, when a live run has been made, what the comparison
 * against the vendor's own answer classified it as.
 *
 * It is built from the operation SPECS, never from the observations, so the
 * file has the same operations in it whether the run reached them or not. An
 * operation a run could not aim at (a repository with no pull requests, an
 * organization with no tickets) reads `not_observed`, which is a different fact
 * from `compatible` and must not be able to look like one.
 */

/** Bumped when a consumer of this file would have to change to read it. */
export const MANIFEST_VERSION = 1;

export type ManifestClassification = Classification | "not_observed";

export interface ManifestOperation {
  operation: string;
  /** The call as an SDK consumer writes it, with ids left unbound. */
  request: string;
  classification: ManifestClassification;
  /** What the connector narrows in the request — its own claim. */
  narrowed: string[];
  /** What the connector removes from the response — its own claim. */
  filtered: string[];
  /** Non-empty ⇒ the connector refuses this operation by name. */
  refused: string[];
  /** What the proxy was OBSERVED to forward, when it differed from the request. */
  observedNarrowing?: string;
  /** Differences that would break a typed SDK consumer. Non-empty ⇒ unsafe. */
  findings?: string[];
  /** Objects the filter removed from the vendor's own answer. */
  objectsRemoved?: number;
}

export interface ManifestAssumption {
  id: string;
  claim: string;
  verdict: Assumption["verdict"];
  /** The file to open when it breaks. */
  encodedIn: string;
}

export interface CoverageManifest {
  connector: Vendor;
  manifestVersion: number;
  /** True when a live run filled the classifications in. */
  observed: boolean;
  operations: ManifestOperation[];
  assumptions: ManifestAssumption[];
}

function manifestOperation(
  spec: OperationSpec,
  observation: Observation | undefined,
): ManifestOperation {
  const base: ManifestOperation = {
    operation: spec.operation,
    request: spec.request,
    classification: observation?.classification ?? "not_observed",
    narrowed: [...spec.narrowed],
    filtered: [...spec.filtered],
    refused: [...spec.refused],
  };
  if (observation === undefined) return base;
  const rewritten =
    observation.upstream !== undefined &&
    observation.upstream !== observation.agentRequest;
  return {
    ...base,
    ...(rewritten && observation.upstream !== undefined
      ? { observedNarrowing: observation.upstream }
      : {}),
    ...(observation.unsafe.length === 0 ? {} : { findings: [...observation.unsafe] }),
    ...(observation.objectsRemoved === 0
      ? {}
      : { objectsRemoved: observation.objectsRemoved }),
  };
}

export function buildManifest(
  connector: Vendor,
  specs: readonly OperationSpec[],
  observations: readonly Observation[],
  assumptions: readonly Assumption[],
): CoverageManifest {
  const byOperation = new Map<string, Observation>();
  for (const observation of observations) {
    byOperation.set(observation.operation, observation);
  }
  return {
    connector,
    manifestVersion: MANIFEST_VERSION,
    observed: observations.length > 0,
    operations: specs.map((spec) =>
      manifestOperation(spec, byOperation.get(spec.operation)),
    ),
    assumptions: assumptions
      .filter((entry) => entry.vendor === connector)
      .map((entry) => ({
        id: entry.id,
        claim: entry.claim,
        verdict: entry.verdict,
        encodedIn: entry.encodedIn,
      })),
  };
}

/**
 * Stable bytes: sorted operations, two-space JSON, trailing newline. A manifest
 * whose diff moved because a run happened to visit its operations in a
 * different order would be a manifest nobody reads the diff of.
 *
 * This is also the manifest's BOUNDARY (`writable.ts`). Every string in the
 * tree goes through `scrub` on the way out, as a `JSON.stringify` replacer
 * rather than field by field: `claim` was the field a per-site convention
 * missed, and a replacer cannot miss the next one. Nothing upstream of here has
 * to remember anything — which is what makes `artifacts.ts` rebuilding the
 * specs from placeholders a convenience rather than the thing keeping the file
 * clean.
 */
export function serializeManifest(manifest: CoverageManifest): string {
  const ordered: CoverageManifest = {
    ...manifest,
    operations: [...manifest.operations].sort((a, b) =>
      a.operation.localeCompare(b.operation),
    ),
    assumptions: [...manifest.assumptions].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
  const text = `${JSON.stringify(
    ordered,
    (_key, value: unknown) => (typeof value === "string" ? scrub(value) : value),
    2,
  )}\n`;
  assertWritable(text, `the ${manifest.connector} manifest`);
  return text;
}
