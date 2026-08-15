import type { FilterRule } from "@missura/core";
import { Kind, type FieldNode } from "graphql";
import { resolveIdArgument, responseKey } from "./narrow-ast";
import { narrowIssuesField } from "./narrow-filter";
import { walkSelectionSet } from "./narrow-walk";
import type { FieldInfo } from "./schema/schema";

/**
 * The one table the schema cannot supply: the vendor's Query root.
 *
 * `schema.json` is extracted from the SDK's MODEL classes, which carry no
 * `Query` type — so the entry points have to be named here. It is NOT the M2
 * path allowlist coming back: it is one level deep and says only "this root
 * field returns that type". Everything under it is decided by the type walk.
 *
 * A root field absent from the table denies, which keeps deny-by-default at the
 * only place the artifact cannot speak for itself.
 */
const ROOT_FIELDS: Readonly<Record<string, FieldInfo>> = {
  customer: { type: "Customer", nullable: false, list: false },
  issue: { type: "Issue", nullable: false, list: false },
  issues: { type: "IssueConnection", nullable: false, list: false },
  viewer: { type: "User", nullable: false, list: false },
};

const NOT_IN_SCOPE = "linear not in mission scope";
const OUT_OF_SCOPE_CUSTOMER = "out-of-scope customer";
const VIEWER = "viewer";

export interface RootOutcome {
  reason?: string;
  field?: FieldNode;
  rules?: readonly FilterRule[];
  strip?: readonly (readonly string[])[];
  /** Set when the mission filter had to move into the request variables. */
  variables?: Record<string, unknown>;
  rewritten?: boolean;
}

function rootInfo(name: string): FieldInfo | undefined {
  return Object.hasOwn(ROOT_FIELDS, name) ? ROOT_FIELDS[name] : undefined;
}

/**
 * `customers` is refused rather than filtered, which is the one place the M3
 * doctrine ("let it run and filter") loses on purpose: there is no proven
 * native narrow for it, and a filtered connection would still carry the
 * vendor's own `pageInfo`, so an agent could binary-search `first` and count
 * the workspace's customers without receiving one of them. `customer(id:)` is
 * the narrowed read and it is already allowed.
 */
function unnarrowable(name: string): string {
  if (name === "customers") {
    return "`customers` cannot be narrowed to the mission — use customer(id)";
  }
  return `root field \`${name}\` is not narrowable under a mission scope`;
}

/**
 * Applies the mission's scope to one root field: the native narrow where the
 * vendor offers one, then the type walk over everything it selects.
 */
export function narrowRoot(
  field: FieldNode,
  customerId: string | undefined,
  variables: Record<string, unknown> | undefined,
): RootOutcome {
  const name = field.name.value;
  if (customerId === undefined) {
    // No Linear entity in the mission: nothing can be narrowed to a customer,
    // so only the caller's own identity is readable.
    if (name !== VIEWER) return { reason: NOT_IN_SCOPE };
    return walked(field, "User", undefined);
  }
  const info = rootInfo(name);
  if (info === undefined) return { reason: unnarrowable(name) };
  if (name === "customer" && resolveIdArgument(field, variables) !== customerId) {
    // Cheaper than filtering, and it keeps the mission's own id out of a
    // response we would otherwise have to prove foreign.
    return { reason: OUT_OF_SCOPE_CUSTOMER };
  }
  if (name !== "issues") return walked(field, info.type, customerId);
  const narrowed = narrowIssuesField(field, customerId, variables);
  if (narrowed.reason !== undefined) return { reason: narrowed.reason };
  const outcome = walked(narrowed.field ?? field, info.type, customerId);
  if (outcome.reason !== undefined) return outcome;
  return {
    ...outcome,
    rewritten: outcome.rewritten === true || narrowed.field !== undefined,
    ...(narrowed.variables === undefined ? {} : { variables: narrowed.variables }),
  };
}

function walked(
  field: FieldNode,
  type: string,
  customerId: string | undefined,
): RootOutcome {
  const selections = field.selectionSet?.selections;
  if (selections === undefined) {
    return { reason: `root field \`${field.name.value}\` must select fields` };
  }
  const result = walkSelectionSet({
    selections,
    type,
    path: ["data", responseKey(field)],
    // A mission with no Linear entity only ever reaches `viewer`, which is
    // metadata: no rule can be emitted, so the id is never read.
    customerId: customerId ?? "",
  });
  if (result.reason !== undefined) return { reason: result.reason };
  const walkedSelections = result.selections;
  const next: FieldNode =
    walkedSelections === undefined || walkedSelections === selections
      ? field
      : {
          ...field,
          selectionSet: { kind: Kind.SELECTION_SET, selections: walkedSelections },
        };
  return {
    field: next,
    rules: result.rules ?? [],
    strip: result.strip ?? [],
    rewritten: result.rewritten === true,
  };
}
