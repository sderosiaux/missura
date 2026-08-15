/**
 * DEV SCRIPT — `pnpm schema:refresh`. Never imported by the proxy: the
 * committed `schema.json` is what ships.
 *
 * Reads the pinned `@linear/sdk` declarations and rewrites `schema.json`. The
 * output is deterministic (types and fields sorted, two-space JSON, trailing
 * newline) so a dependency bump produces a diff a human can read, and the
 * drift test in `extract.test.ts` fails until someone has read it.
 *
 * NO network, NO introspection, NO vendor credential: the schema source is a
 * file already on disk at the version the lockfile pins.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSdkDeclarations, type SdkSchema } from "./sdk-declarations";
import { EXTRACTED_TYPES, UNION_FIELDS } from "./types";

const SDK_PACKAGE = "@linear/sdk";
const DECLARATIONS = "dist/index.d.mts";
const ARTIFACT = "schema.json";

export interface SchemaDocument extends SdkSchema {
  /** The package the declarations came from, so the artifact is self-describing. */
  readonly source: string;
  /** The exact version extracted — drift is a version change plus a diff. */
  readonly sdkVersion: string;
}

interface PackageManifest {
  readonly version?: unknown;
}

function sdkRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve(`${SDK_PACKAGE}/package.json`));
}

function sdkVersion(root: string): string {
  const raw: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = (raw as PackageManifest).version;
  if (typeof version !== "string") {
    throw new Error(`${SDK_PACKAGE} package.json carries no version string`);
  }
  return version;
}

function artifactPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), ARTIFACT);
}

/** Parses the SDK declarations into the document that becomes `schema.json`. */
export function buildSchemaDocument(): SchemaDocument {
  const root = sdkRoot();
  const declarations = readFileSync(join(root, DECLARATIONS), "utf8");
  const parsed = parseSdkDeclarations(declarations, EXTRACTED_TYPES, UNION_FIELDS);
  return {
    source: `${SDK_PACKAGE}/${DECLARATIONS}`,
    sdkVersion: sdkVersion(root),
    types: parsed.types,
    leaves: parsed.leaves,
    unions: parsed.unions,
  };
}

/**
 * One serialization, used both to write the artifact and to compare against it.
 * Key order is already stable from the parser; the shape below fixes the order
 * of the top-level keys too.
 */
export function serializeSchema(document: SchemaDocument): string {
  const ordered = {
    source: document.source,
    sdkVersion: document.sdkVersion,
    leaves: document.leaves,
    unions: document.unions,
    types: document.types,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The artifact as committed, byte for byte. */
export function readCommittedSchema(): string {
  return readFileSync(artifactPath(), "utf8");
}

export function refreshSchema(): string {
  const serialized = serializeSchema(buildSchemaDocument());
  writeFileSync(artifactPath(), serialized, "utf8");
  return serialized;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const written = refreshSchema();
  const document: SchemaDocument = buildSchemaDocument();
  process.stdout.write(
    `schema.json refreshed from ${SDK_PACKAGE}@${document.sdkVersion}: ` +
      `${String(Object.keys(document.types).length)} types, ` +
      `${String(written.length)} bytes\n`,
  );
}
