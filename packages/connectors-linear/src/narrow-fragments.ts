import {
  Kind,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type SelectionNode,
} from "graphql";

export interface InlineOutcome {
  /** Set when the document cannot be resolved — the whole document dies. */
  reason?: string;
  fields?: readonly FieldNode[];
  /** True when a spread or an inline fragment was flattened away. */
  inlined?: boolean;
}

interface Resolver {
  fragments: Map<string, FragmentDefinitionNode>;
  inlined: boolean;
}

function collect(doc: DocumentNode): Map<string, FragmentDefinitionNode> | string {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of doc.definitions) {
    if (definition.kind !== Kind.FRAGMENT_DEFINITION) continue;
    const name = definition.name.value;
    if (fragments.has(name)) {
      return `fragment \`${name}\` is defined twice — the document is ambiguous`;
    }
    fragments.set(name, definition);
  }
  return fragments;
}

function resolveField(
  field: FieldNode,
  resolver: Resolver,
  open: ReadonlySet<string>,
): FieldNode | string {
  const set = field.selectionSet;
  if (set === undefined) return field;
  const inner = resolve(set.selections, resolver, open);
  if (typeof inner === "string") return inner;
  return { ...field, selectionSet: { ...set, selections: inner } };
}

/**
 * Flattens a NAMED spread into the scope that wrote it. A directive on the
 * spread itself (`...F @skip`) would be lost by the flattening, so it is
 * refused rather than silently dropped.
 *
 * A named fragment declared on some OTHER type is not refused here — it is
 * flattened, and the walk then resolves its fields against the type they landed
 * on, where a field that does not exist is a deny. Fail-closed either way, and
 * this file stays free of the schema.
 */
function resolveSpread(
  selection: SelectionNode,
  resolver: Resolver,
  open: ReadonlySet<string>,
): readonly SelectionNode[] | string {
  if ((selection.directives ?? []).length > 0) {
    return "a directive on a fragment cannot be inlined — spell the fields out";
  }
  resolver.inlined = true;
  if (selection.kind === Kind.INLINE_FRAGMENT) {
    return resolve(selection.selectionSet.selections, resolver, open);
  }
  const name = selection.name.value;
  if (open.has(name)) return `fragment \`${name}\` is recursive`;
  const definition = resolver.fragments.get(name);
  if (definition === undefined) return `unknown fragment \`${name}\``;
  return resolve(definition.selectionSet.selections, resolver, new Set([...open, name]));
}

function resolve(
  selections: readonly SelectionNode[],
  resolver: Resolver,
  open: ReadonlySet<string>,
): readonly SelectionNode[] | string {
  const out: SelectionNode[] = [];
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      const resolved = resolveField(selection, resolver, open);
      if (typeof resolved === "string") return resolved;
      out.push(resolved);
      continue;
    }
    // An inline fragment with a type condition is KEPT, not flattened: it is
    // how a union is entered, and a union has no fields of its own, so
    // flattening `... on GithubMetadata { repo }` would print a document the
    // vendor rejects. `@linear/sdk`'s own `ExternalEntityInfo` fragment is
    // exactly this shape.
    if (selection.kind === Kind.INLINE_FRAGMENT && selection.typeCondition !== undefined) {
      if ((selection.directives ?? []).length > 0) {
        return "a directive on a fragment cannot be inlined — spell the fields out";
      }
      const inner = resolve(selection.selectionSet.selections, resolver, open);
      if (typeof inner === "string") return inner;
      out.push({
        ...selection,
        selectionSet: { ...selection.selectionSet, selections: inner },
      });
      continue;
    }
    const spread = resolveSpread(selection, resolver, open);
    if (typeof spread === "string") return spread;
    out.push(...spread);
  }
  return out;
}

/**
 * Resolves every fragment reachable from the root fields, so the scope walk
 * sees the document the vendor would actually execute: a fragment is a second
 * name for a traversal, and a policy that reads only the operation body can be
 * handed `issues { nodes { ...Escape } }` and see nothing at all.
 *
 * The resolved fields are what gets forwarded — what NARROW validated is what
 * runs, with no fragment definition left behind to reinterpret.
 */
export function inlineFragments(
  doc: DocumentNode,
  roots: readonly FieldNode[],
): InlineOutcome {
  const fragments = collect(doc);
  if (typeof fragments === "string") return { reason: fragments };
  const resolver: Resolver = { fragments, inlined: false };
  const fields: FieldNode[] = [];
  for (const root of roots) {
    const resolved = resolveField(root, resolver, new Set());
    if (typeof resolved === "string") return { reason: resolved };
    fields.push(resolved);
  }
  return { fields, inlined: resolver.inlined };
}
