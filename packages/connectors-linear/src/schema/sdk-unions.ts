import type { UnionSpec } from "./types";

/**
 * The one declaration shape the class parser cannot name on its own: a GraphQL
 * union, which `@linear/sdk` spells as an indexed access into its generated
 * fragment type (`metadata?: ExternalEntityInfoFragment["metadata"] | null`).
 *
 * The member list is curated (`UNION_FIELDS`) because the declarations do not
 * carry it. Everything else here exists to keep that curation honest: it must
 * still be the shape the SDK uses, and every member must still be a class the
 * SDK declares. Both are checked at extraction time, so drift breaks the build
 * rather than the request.
 */

/** How the SDK spells a union field. */
const INDEXED_ACCESS = /^\w+Fragment\["\w+"\]$/;

/**
 * A field the curation declares a union. The declared shape must still be the
 * indexed access the SDK uses for one, or the curation has gone stale against a
 * dependency bump and is refused rather than applied to whatever is there now.
 */
export function readUnionProperty(
  owner: string,
  field: string,
  optional: boolean,
  declared: string,
  spec: UnionSpec,
): { type: string; nullable: boolean; list: boolean } {
  let raw = declared;
  let nullable = optional;
  if (raw.endsWith(" | null")) {
    raw = raw.slice(0, -" | null".length);
    nullable = true;
  }
  if (!INDEXED_ACCESS.test(raw.trim())) {
    throw new Error(
      `${owner}.${field} is curated as the union \`${spec.name}\` but the SDK ` +
        `declares it as \`${declared}\` — re-read the declarations`,
    );
  }
  return { type: spec.name, nullable, list: false };
}

/**
 * A member the declarations do not declare would be an unknown type behind a
 * walkable name: the union must fail the extraction, not the request.
 */
export function assertUnionsDeclared(
  unions: Readonly<Record<string, readonly string[]>>,
  declared: ReadonlySet<string>,
): void {
  for (const [union, members] of Object.entries(unions)) {
    for (const member of members) {
      if (declared.has(member)) continue;
      throw new Error(
        `union \`${union}\` names \`${member}\`, which the SDK does not declare`,
      );
    }
  }
}
