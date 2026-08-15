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
 * Flattens spreads and inline fragments into plain fields. A directive on the
 * spread itself (`...F @skip`) would be lost by the flattening, so it is
 * refused rather than silently dropped.
 */
function resolveSpread(
  selection: SelectionNode,
  resolver: Resolver,
  open: ReadonlySet<string>,
): readonly FieldNode[] | string {
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
): readonly FieldNode[] | string {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      const resolved = resolveField(selection, resolver, open);
      if (typeof resolved === "string") return resolved;
      fields.push(resolved);
      continue;
    }
    const spread = resolveSpread(selection, resolver, open);
    if (typeof spread === "string") return spread;
    fields.push(...spread);
  }
  return fields;
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
  const fields = resolve(roots, resolver, new Set());
  if (typeof fields === "string") return { reason: fields };
  return { fields, inlined: resolver.inlined };
}
