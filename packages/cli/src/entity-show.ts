import type {
  Entity,
  EntityLink,
  FeasibilityReport,
  OperationGap,
} from "@missura/core";

/**
 * `missura entity show`, as text. The operator's view and nobody else's: link
 * ids, statuses, who confirmed what, and for each gap the command that closes
 * it. Nothing here is ever handed to an agent, so nothing here is redacted.
 */

function columns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

function linkRow(link: EntityLink): string[] {
  const stamp =
    link.confirmedBy === undefined
      ? ""
      : `— ${link.confirmedBy}${link.confirmedAt === undefined ? "" : ` ${link.confirmedAt}`}`;
  return [`  ${link.system}`, link.id, link.status, link.method, link.evidence, stamp];
}

/** The write's grant, spelled as the flag that makes it: a possible write still needs naming. */
function possibleRow(op: FeasibilityReport["operations"][number]): string[] {
  return [`  ${op.name}`, op.effect, op.effect === "read" ? "" : `grant by name: --allow ${op.name}`];
}

export function showLines(entity: Entity, report: FeasibilityReport): string[] {
  const possible = report.operations.filter((op) => op.possible);
  const gaps = report.operations.filter((op): op is OperationGap => !op.possible);
  return [
    `${entity.key}  ${entity.displayName}`,
    `domains  ${entity.domains.join(", ")}`,
    "links",
    ...columns(entity.links.map(linkRow)),
    "possible",
    ...(possible.length === 0 ? ["  (none)"] : columns(possible.map(possibleRow))),
    "gaps",
    ...(gaps.length === 0
      ? ["  (none)"]
      : columns(
          gaps.map((op) => [`  ${op.name}`, op.effect, op.cause, op.remediation]),
        )),
  ];
}
