import { Kind, type FieldNode } from "graphql";

/**
 * A node of the traversal allowlist: the fields that may carry a selection set
 * at this depth. An empty node means "scalars only" — every leaf is fine, no
 * relation may be followed.
 */
interface Traversal {
  readonly [field: string]: Traversal;
}

const SCALARS: Traversal = {};

/**
 * The relations owned by an issue that is already proven in scope: its
 * customer, the people on it, its state, its labels and its comments. `team`,
 * `organization`, `project`, `cycle`, `parent`, `children`, `relations`,
 * `subscribers` and `attachments` are absent on purpose — none of them is
 * customer-bound, and each re-expands to the whole workspace.
 */
const ISSUE_RELATIONS: Traversal = {
  customer: SCALARS,
  assignee: SCALARS,
  creator: SCALARS,
  state: SCALARS,
  labels: { nodes: SCALARS },
  comments: { nodes: { user: SCALARS } },
};

/**
 * Root traversals. `viewer` is a User and `customer` is a Customer: both are
 * scalars-only, because every relation hanging off them (`assignedIssues`,
 * `teams`, `projects`, …) is a full-workspace read.
 */
const ROOTS: Traversal = {
  issues: { nodes: ISSUE_RELATIONS, pageInfo: SCALARS },
  issue: { ...ISSUE_RELATIONS, pageInfo: SCALARS },
  customer: SCALARS,
  viewer: SCALARS,
};

/**
 * Own-property lookup only: `allowed["constructor"]` would otherwise resolve
 * through `Object.prototype` and hand a traversal to a field that has none.
 */
function child(allowed: Traversal, field: string): Traversal | undefined {
  return Object.hasOwn(allowed, field) ? allowed[field] : undefined;
}

function offScope(path: readonly string[]): string {
  const field = path[path.length - 1] ?? "";
  return `field \`${field}\` (\`${path.join(" > ")}\`) is outside the mission traversal allowlist`;
}

function walk(
  fields: readonly FieldNode[],
  allowed: Traversal,
  path: readonly string[],
): string | undefined {
  for (const field of fields) {
    const selections = field.selectionSet?.selections;
    if (selections === undefined) continue; // a scalar leaf is always fine
    const here = [...path, field.name.value];
    const next = child(allowed, field.name.value);
    if (next === undefined) return offScope(here);
    const nested: FieldNode[] = [];
    for (const selection of selections) {
      if (selection.kind !== Kind.FIELD) {
        // Fragments are inlined before the walk; one reaching here would be an
        // unproven path, so it dies with the document.
        return `unresolved fragment under \`${here.join(" > ")}\``;
      }
      nested.push(selection);
    }
    const denial = walk(nested, next, here);
    if (denial !== undefined) return denial;
  }
  return undefined;
}

/**
 * The binding global rule: the WHOLE document is validated, not just its root
 * fields. Root-only narrowing leaks — `issues { nodes { team { issues } } }`
 * re-expands to every customer, and the same nesting under `issue(id)` hands
 * back a payload the ownership post-check never looks at. So every field
 * carrying a selection set must sit on an allowlisted path; anything else
 * denies the document, naming the field at fault.
 */
export function traversalDenial(roots: readonly FieldNode[]): string | undefined {
  return walk(roots, ROOTS, []);
}
