/**
 * The curated type lists. Pure data, no imports: the dev-time extractor reads
 * them to decide what to pull out of the SDK, and the runtime classification
 * reads them to decide what those types mean. Splitting them out keeps the
 * extractor independent of `schema.json`, which it is the one writing.
 *
 * The judgment behind each entry lives in `classification.ts` (`METADATA_SAFETY`).
 */

/** Objects that belong TO a customer: they need an owner check and a filter rule. */
export const CUSTOMER_SCOPED_TYPES: readonly string[] = [
  "Attachment",
  "Comment",
  "Customer",
  "CustomerNeed",
  "Issue",
];

/** Workspace furniture: shared by every customer, owned by none. */
export const METADATA_OBJECT_TYPES: readonly string[] = [
  "ActorBot",
  "Cycle",
  "ExternalEntityInfo",
  "ExternalEntityInfoGithubMetadata",
  "ExternalEntityInfoJiraMetadata",
  "ExternalEntitySlackMetadata",
  "ExternalUser",
  "Favorite",
  "IssueLabel",
  "IssueRelation",
  "IssueSharedAccess",
  "Organization",
  "PageInfo",
  "Project",
  "ProjectMilestone",
  "Reaction",
  "Team",
  "Template",
  "User",
  "WorkflowState",
];

/**
 * The Relay wrappers. A connection is a shell — `nodes` plus `pageInfo` — that
 * carries no ownership of its own, so the NODE type decides what happens
 * inside it.
 */
export const CONNECTION_TYPES: readonly string[] = [
  "AttachmentConnection",
  "CommentConnection",
  "CustomerConnection",
  "CustomerNeedConnection",
  "CycleConnection",
  "ExternalUserConnection",
  "FavoriteConnection",
  "IssueConnection",
  "IssueLabelConnection",
  "IssueRelationConnection",
  "ProjectConnection",
  "ProjectMilestoneConnection",
  "TeamConnection",
  "TemplateConnection",
  "UserConnection",
  "WorkflowStateConnection",
];

export const METADATA_TYPES: readonly string[] = [
  ...METADATA_OBJECT_TYPES,
  ...CONNECTION_TYPES,
];

/** What the extractor pulls out of the SDK: exactly what has been classified. */
export const EXTRACTED_TYPES: readonly string[] = [
  ...CUSTOMER_SCOPED_TYPES,
  ...METADATA_TYPES,
];

/** A GraphQL union: a name for the alternative, and the types it may be. */
export interface UnionSpec {
  /**
   * The union's name in the artifact. SYNTHESIZED from the parent type and the
   * field: the SDK's TypeScript spells the field as an indexed access into a
   * generated fragment type (`ExternalEntityInfoFragment["metadata"]`), which
   * names no union at all. The name never leaves the connector — a GraphQL
   * document only ever spells the MEMBERS, in `... on <Member>` conditions.
   */
  readonly name: string;
  readonly members: readonly string[];
}

/**
 * The unions the connector models, per parent type and field.
 *
 * Curated for the same reason the type lists are: the declarations cannot be
 * read for the member list. Not asserted, though — `extract.test.ts` reads the
 * SDK's own generated `ExternalEntityInfo` fragment and requires exactly these
 * members, and the extractor refuses a member that is not a declared class or a
 * field the SDK no longer declares as an indexed access.
 *
 * `ExternalEntityInfo.metadata` is the one that matters: the `@linear/sdk`
 * `Issue` fragment selects `syncedWith { ...ExternalEntityInfo }`, so without
 * it EVERY typed SDK read of an issue is denied on a field carrying nothing but
 * scalars. Its three members are scalars-only metadata types, which is what
 * makes allowing it decidable rather than a judgement call: a union is walkable
 * exactly when ALL of its members are.
 */
export const UNION_FIELDS: Readonly<
  Record<string, Readonly<Record<string, UnionSpec>>>
> = {
  ExternalEntityInfo: {
    metadata: {
      name: "ExternalEntityInfoMetadata",
      members: [
        "ExternalEntityInfoGithubMetadata",
        "ExternalEntityInfoJiraMetadata",
        "ExternalEntitySlackMetadata",
      ],
    },
  },
};
