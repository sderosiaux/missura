import { Kind, type FieldNode, type SelectionNode } from "graphql";
import { fieldNode, responseKey, selectionFor } from "./narrow-ast";

/**
 * Making ownership PROVABLE in the response.
 *
 * A customer-scoped object is only filterable if the answer carries the route
 * to its owning customer. The connector knows that route as a path
 * (`ownerPath`); this file makes sure the document selects it, adding only the
 * part the agent did not ask for and reporting exactly what was added — because
 * what we add is what has to come back out on the way to the agent.
 *
 * `"*"` segments of an owner path are RESPONSE structure (every element of a
 * list), not selection structure: they advance the response path without
 * consuming a selection level.
 */

export interface OwnerSelection {
  /** The selection set the vendor should run. */
  selections: readonly SelectionNode[];
  /**
   * Response path of the node we added, RELATIVE to the guarded object, or
   * `undefined` when the agent already selected the whole route. A one-segment
   * path is a field of the guarded object itself, which is what
   * `FilterRule.injected` means; anything longer sits inside a field the agent
   * did ask for and must be stripped by absolute path instead.
   */
  injectedAt?: readonly string[];
}

function chain(ownerPath: readonly string[], from: number): SelectionNode {
  const rest = ownerPath.slice(from).filter((segment) => segment !== "*");
  const [head, ...tail] = rest;
  if (head === undefined) throw new Error("owner path chain is empty");
  return tail.length === 0
    ? fieldNode(head)
    : fieldNode(head, [chain(rest, 1)]);
}

/**
 * Ensures `ownerPath` is selected, descending one segment at a time.
 *
 * A response key the agent aliased to a DIFFERENT field is refused rather than
 * reused: the ownership check would then read a value the agent chose, which is
 * the whole ballgame. An aliased-away key is not a problem — the key we need is
 * simply absent, so we add our own field under its real name.
 */
function ensure(
  selections: readonly SelectionNode[],
  ownerPath: readonly string[],
  index: number,
  responsePath: readonly string[],
): OwnerSelection | string {
  let at = index;
  const here: string[] = [...responsePath];
  while (ownerPath[at] === "*") {
    here.push("*");
    at += 1;
  }
  const segment = ownerPath[at];
  if (segment === undefined) return { selections };
  const reached = [...here, segment];
  const existing = selectionFor(selections, segment);
  if (existing === undefined) {
    return {
      selections: [...selections, chain(ownerPath, at)],
      injectedAt: reached,
    };
  }
  if (existing.name.value !== segment) {
    return `response key \`${segment}\` is aliased to another field — ownership cannot be proven`;
  }
  if (at === ownerPath.length - 1) return { selections };
  const inner = existing.selectionSet?.selections;
  if (inner === undefined) {
    return `\`${segment}\` carries no selection — ownership cannot be proven`;
  }
  const deeper = ensure(inner, ownerPath, at + 1, reached);
  if (typeof deeper === "string") return deeper;
  if (deeper.injectedAt === undefined) return { selections };
  const widened: FieldNode = {
    ...existing,
    selectionSet: { kind: Kind.SELECTION_SET, selections: deeper.selections },
  };
  return {
    selections: selections.map((selection) =>
      selection.kind === Kind.FIELD && responseKey(selection) === segment
        ? widened
        : selection,
    ),
    injectedAt: deeper.injectedAt,
  };
}

/**
 * The document's own selection of the owner route, widened by whatever was
 * missing. Returns the reason it cannot be proven, which denies the request:
 * an object we cannot prove is one we could only serve blind.
 */
export function withOwnerSelection(
  selections: readonly SelectionNode[],
  ownerPath: readonly string[],
): OwnerSelection | string {
  if (ownerPath.length === 0) {
    return "owner path is empty — ownership cannot be proven";
  }
  return ensure(selections, ownerPath, 0, []);
}
