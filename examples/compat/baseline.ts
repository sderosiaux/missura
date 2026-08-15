#!/usr/bin/env tsx
/**
 * `pnpm compat:manifest` — writes the coverage manifests with NO network, NO
 * credential and NO proxy.
 *
 * The manifest is a deliverable in its own right (PRD F-014): it says, per
 * connector, every operation, what is narrowed, what is filtered and what is
 * refused. All of that is a property of the connectors, not of a run — so it can
 * be generated, committed and reviewed by someone who will never point the live
 * suite at a production tenant, and a change to a connector's coverage shows up
 * as a diff in a committed file rather than in an artifact only one laptop has.
 *
 * `classification` reads `not_observed` here. `pnpm compat` overwrites these
 * same files with the classifications a live run measured.
 */
import { manifests, writeArtifacts } from "./artifacts";
import { renderReport } from "./report";

const built = manifests([], []);
const written = writeArtifacts(
  built,
  renderReport({ assumptions: [], observations: [], skips: {}, exercised: [] }),
);

const operations = built.reduce(
  (total, manifest) => total + manifest.operations.length,
  0,
);
process.stdout.write(
  `${String(operations)} operations across ${String(built.length)} connectors, unobserved\n` +
    written.map((path) => `wrote ${path}\n`).join(""),
);
