import type { Observation } from "./exchange";
import type { Assumption, Skips } from "./harness";
import type { Vendor } from "./vendor-shapes";
import { assertWritable, scrub } from "./writable";

/**
 * The report a human reads, and the exit code a CI reads.
 *
 * Two rules shape everything below. It is COMMITTED, so nothing in it is a
 * vendor payload — and the whole document goes through the boundary once, in
 * `renderReport`, rather than through a `redact` at each cell that remembered
 * one (`writable.ts`). And it has exactly two kinds of failure — a BROKEN
 * assumption and an `unsafe` operation — so a reader who only reads the first
 * section knows whether anything is wrong and which file to open.
 */

const VENDORS: readonly Vendor[] = ["linear", "github", "zendesk"];

export interface ReportInput {
  assumptions: readonly Assumption[];
  observations: readonly Observation[];
  skips: Skips;
  /** Vendors this run actually exercised — the rest are skipped, not passing. */
  exercised: readonly Vendor[];
}

/** A markdown cell: no pipe may survive, or the table stops being one. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function brokenAssumptions(
  assumptions: readonly Assumption[],
): Assumption[] {
  return assumptions.filter((entry) => entry.verdict === "BROKEN");
}

export function unsafeOperations(
  observations: readonly Observation[],
): Observation[] {
  return observations.filter((entry) => entry.classification === "unsafe");
}

/** True when this run must fail. The only two categories that can. */
export function failed(input: ReportInput): boolean {
  return (
    brokenAssumptions(input.assumptions).length > 0 ||
    unsafeOperations(input.observations).length > 0
  );
}

function verdictSection(input: ReportInput): string[] {
  const broken = brokenAssumptions(input.assumptions);
  const unsafe = unsafeOperations(input.observations);
  if (input.exercised.length === 0) {
    return [
      "**Nothing ran.** No connector had credentials in the environment, so this",
      "report records what was NOT checked and claims nothing at all. A manifest",
      "written in this state carries the catalogue — every operation, what is",
      "narrowed, filtered and refused — with no classification against it.",
    ];
  }
  if (broken.length === 0 && unsafe.length === 0) {
    return [
      "**No assumption broke and no operation was classified `unsafe`.**",
      "",
      "That is the whole claim. Everything else in this report is a difference",
      "between the vendor's answer and missura's that a typed SDK consumer",
      "survives — narrowing and filtering are the product.",
    ];
  }
  const lines = ["**This run FAILED.**", ""];
  for (const entry of broken) {
    lines.push(
      `- BROKEN \`${entry.id}\` — the assumption is encoded in \`${entry.encodedIn}\`. ${cell(entry.evidence)}`,
    );
  }
  for (const entry of unsafe) {
    lines.push(
      `- UNSAFE \`${entry.vendor}\` / \`${entry.operation}\` — ${entry.unsafe.map((line) => cell(line)).join("; ")}`,
    );
  }
  return lines;
}

function assumptionTable(entries: readonly Assumption[]): string[] {
  if (entries.length === 0) return ["_No assumption was checked for this connector._"];
  const lines = [
    "| verdict | assumption | evidence | encoded in |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    lines.push(
      `| ${entry.verdict} | \`${entry.id}\` | ${cell(entry.evidence)} | \`${entry.encodedIn}\` |`,
    );
  }
  return lines;
}

/**
 * The one way an `unsafe` finding can be an artefact rather than a fault, said
 * out loud beside the finding instead of buried in a caveat nobody reads.
 *
 * When the FILTER removed objects, REFILL walks forward and merges later ones
 * to keep the page as full as the mission allows. The page then holds objects
 * the vendor's own answer to THIS call never contained — so a field that is an
 * object on one side and `null` on the other may be two different records
 * disagreeing, not the proxy changing a type.
 *
 * The trigger is the WALK, not the shortfall. Keying it on `objectsRemoved`
 * printed the caveat for a PARTIAL refill and withheld it for a TOTAL one —
 * where the page came back exactly as long as the vendor's, so the diff sees no
 * shrink, and every record in it may still be a different one. That is the case
 * where the finding is most likely to be bogus, and it was the one case with no
 * warning on it. So: more than one upstream call for this operation, or objects
 * gone from the page, and the caveat travels.
 *
 * It over-attaches, on purpose: a PARENT PROOF also costs an extra call and
 * substitutes nothing. A caveat too many asks a reader to check something that
 * turns out fine; a caveat missing lets a substitution ship as a defect.
 */
function substitutionCaveat(entry: Observation): string[] {
  const walked = entry.upstreamCalls.length > 1;
  if (entry.objectsRemoved === 0 && !walked) return [];
  const removed =
    entry.objectsRemoved === 0
      ? "the page came back full after more than one upstream call, so it was refilled"
      : `${String(entry.objectsRemoved)} object(s) were removed and the page refilled`;
  return [
    `${removed}, so the two answers may describe DIFFERENT records — check whether the finding above is the proxy or the substitution`,
  ];
}

function observationTable(entries: readonly Observation[]): string[] {
  if (entries.length === 0) {
    return ["_No operation was exercised for this connector._"];
  }
  const lines = [
    "| classification | operation | vendor → missura | what differed |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    const statuses = `${entry.directStatus === 0 ? "not issued" : String(entry.directStatus)} → ${String(entry.proxiedStatus)}`;
    const differences =
      entry.classification === "unsafe"
        ? [...entry.unsafe, ...substitutionCaveat(entry)]
            .map((line) => cell(line))
            .join("; ")
        : [...entry.reasons, ...entry.notes]
            .map((line) => cell(line))
            .join("; ");
    lines.push(
      `| ${entry.classification} | \`${entry.operation}\` | ${statuses} | ${differences === "" ? "nothing" : differences} |`,
    );
  }
  return lines;
}

function connectorSection(vendor: Vendor, input: ReportInput): string[] {
  const lines = [`## ${vendor}`, ""];
  const skip = input.skips[vendor];
  if (!input.exercised.includes(vendor)) {
    lines.push(
      `SKIPPED — ${skip ?? "no credential for this connector was present in the environment"}.`,
      "",
      "A skip proves nothing. It is here so a reader can see what this run did NOT check.",
      "",
    );
    return lines;
  }
  lines.push(
    "### Half A — assumptions this connector encodes, checked against the vendor",
    "",
    ...assumptionTable(input.assumptions.filter((entry) => entry.vendor === vendor)),
    "",
    "### Half B — the vendor's own answer against missura's",
    "",
    ...observationTable(
      input.observations.filter((entry) => entry.vendor === vendor),
    ),
    "",
  );
  return lines;
}

const PREAMBLE: readonly string[] = [
  "# missura compatibility report",
  "",
  "Generated by `pnpm compat`, which calls each vendor DIRECTLY with the vendor's",
  "own credential and then makes the SAME call through an in-process missura with",
  "a mission token. Two halves:",
  "",
  "- **Half A** checks the facts about the vendor that a connector's code encodes.",
  "  A `BROKEN` verdict names the source file that has to change.",
  "- **Half B** classifies every difference between the two answers.",
  "  `compatible`, `compatible_with_rewrite`, `compatible_with_filter` and",
  "  `unsupported` are the product working. `unsafe` is the only failing one:",
  "  it means a difference a typed SDK consumer would not survive.",
  "",
  "No vendor response body is in this file, and no error message from one: a body",
  "is written as its key set and its size, an error as its class. Request targets",
  "ARE here, because they are the evidence for what was narrowed — every value",
  "this run learned from a tenant reads as a placeholder (`{id}`, `{uuid}`,",
  "`{email}`, `{subdomain}`, `{key}`). The whole document goes through that",
  "boundary once, on the way out (`examples/compat/writable.ts`).",
  "",
  "One known way to read an `unsafe` row wrong: when the filter removed objects,",
  "the proxy walks forward and refills the page, so the two answers can hold",
  "DIFFERENT records — and two different records disagreeing about a nullable",
  "field is not the proxy changing a type. Every row where that is possible says",
  "so in its own cell.",
  "",
];

/**
 * The report, and the boundary it leaves through: the document is scrubbed
 * ONCE, whole, rather than cell by cell. A cell added later is covered by
 * construction, which a `redact` per call site never was.
 */
export function renderReport(input: ReportInput): string {
  const lines = [
    ...PREAMBLE,
    "## Verdict",
    "",
    ...verdictSection(input),
    "",
  ];
  for (const vendor of VENDORS) {
    lines.push(...connectorSection(vendor, input));
  }
  const text = scrub(`${lines.join("\n")}\n`);
  assertWritable(text, "the compatibility report");
  return text;
}

/** The one-screen summary the run prints to stdout, table and all. */
export function renderSummary(input: ReportInput): string {
  const counts = new Map<string, number>();
  for (const entry of input.assumptions) {
    counts.set(entry.verdict, (counts.get(entry.verdict) ?? 0) + 1);
  }
  for (const entry of input.observations) {
    counts.set(
      entry.classification,
      (counts.get(entry.classification) ?? 0) + 1,
    );
  }
  const summary = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name} ${String(count)}`)
    .join("  ·  ");
  return summary === "" ? "nothing ran" : summary;
}
