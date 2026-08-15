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
