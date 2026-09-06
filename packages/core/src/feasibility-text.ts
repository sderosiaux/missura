import type { LinkSystem } from "./entity-graph";
import type { OperationGap } from "./feasibility";

/**
 * What a gap TELLS THE OPERATOR: the one command that closes it. Kept beside
 * the report the way `remediation-text.ts` sits beside `remediation.ts`, and
 * for the same reason — the shape is decided in one file, the wording in
 * another, and only the wording is allowed an opinion.
 *
 * Every command named here exists. A remediation pointing at a subcommand
 * nobody built is the operator's version of the hallucinated workaround the
 * agent-facing text exists to prevent.
 */

/** How an id is spelled in each system, for the command a no_link gap prints. */
const ID_SHAPE: Record<LinkSystem, string> = {
  linear: "<customer id>",
  github: "<owner/name>",
  zendesk: "<organization id>",
};

export function gapRemediation(
  gap: Pick<OperationGap, "name" | "system" | "cause"> & { status?: string },
  entity: string,
): string {
  const { system } = gap;
  switch (gap.cause) {
    case "system_not_connected":
      return `${system} is not configured on this deployment — connect it: missura init (give it a ${system} connection), then missura run`;
    case "no_link":
      return `${entity} has no ${system} link — add one: missura entity link ${entity} ${system} ${ID_SHAPE[system]}`;
    case "link_not_confirmed":
      return linkRemediation(entity, system, gap.status ?? "proposed");
    case "not_granted":
      return `a write is granted by its exact name — mint with it: missura exec --entity ${entity} --allow ${gap.name} --purpose <why> -- <cmd>`;
  }
}

/**
 * Three unconfirmed statuses, three next steps. A proposed link wants a
 * human's yes; a rejected one got a human's no, so confirming it is an
 * explicit reversal; a broken one names an id the vendor no longer resolves,
 * and confirming it again would grant a mapping nobody can check.
 */
function linkRemediation(entity: string, system: LinkSystem, status: string): string {
  if (status === "rejected") {
    return `${entity}'s ${system} link was rejected by a human — if that was wrong, confirm it: missura entity confirm ${entity} ${system}; otherwise add the right one: missura entity link ${entity} ${system} ${ID_SHAPE[system]}`;
  }
  if (status === "broken") {
    return `${entity}'s ${system} link is broken (its id no longer resolves at the vendor) — relink it: missura entity link ${entity} ${system} ${ID_SHAPE[system]}`;
  }
  return `${entity}'s ${system} link is proposed, not confirmed — confirm it: missura entity confirm ${entity} ${system}`;
}
