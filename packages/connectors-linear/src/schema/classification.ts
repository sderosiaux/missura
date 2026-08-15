/**
 * The curated half of the semantic engine. The artifact says what EXISTS; this
 * file says what it MEANS — which types carry another customer's data, which
 * are workspace furniture, and how to reach the owning customer from each.
 *
 * Deny by default: `typeClass` answers `"denied"` for anything not named here,
 * including a type the SDK declares but nobody has judged.
 */

import { leafType, unionMembers } from "./schema";
import { CUSTOMER_SCOPED_TYPES, METADATA_TYPES } from "./types";

export {
  CONNECTION_TYPES,
  CUSTOMER_SCOPED_TYPES,
  METADATA_OBJECT_TYPES,
  METADATA_TYPES,
} from "./types";

export type TypeClass = "customer-scoped" | "metadata" | "denied";

/**
 * Per metadata type, why reading it cannot hand back another customer's data.
 * Verified against the artifact, not asserted: `classification.test.ts`
 * recomputes the two tables below from `schema.json` and requires an exact
 * match, so a dependency bump that adds a relation fails the build instead of
 * quietly widening the surface.
 */
export const METADATA_SAFETY: Readonly<Record<string, string>> = {
  ActorBot: "scalars only (avatarUrl, name, subType, type) — no relations at all",
  Cycle:
    "team/inheritedFrom are metadata singles; `issues` and `uncompletedIssuesUponClose` are IssueConnections — collections, see the table below",
  ExternalEntityInfo:
    "`id`, `service`, and `metadata` — a union whose three members are all scalars-only metadata types, so entering it can reach nothing else",
  ExternalEntityInfoGithubMetadata:
    "scalars only (number, owner, repo); reachable as a member of the ExternalEntityInfo.metadata union",
  ExternalEntityInfoJiraMetadata:
    "scalars only (issueKey, issueTypeId, projectId); same route in",
  ExternalEntitySlackMetadata:
    "scalars only (channelId, channelName, isFromSlack, messageUrl); same route in",
  ExternalUser:
    "scalars only — its `organization` getter is a root query with no backing private field and was EXCLUDED",
  Favorite:
    "a user's own bookmark row; `customer` and `issue` are NULLABLE singles the response filter can null out, `children` is a FavoriteConnection (metadata nodes)",
  InitiativeUpdate:
    "a status post ON an initiative — how the workspace reports its own delivery, the same reading as `Project` and `ProjectMilestone`, which it reports on: written by a workspace member, addressed to the workspace, owned by no customer; `user` is a metadata single and `reactions` a list of METADATA, `initiative` returns the unclassified `Initiative` (denied by type), and `comments` is a CommentConnection — collection, see the table below",
  IssueLabel:
    "workspace label; relations are metadata singles, but `issues` is an IssueConnection — collection, see the table below",
  IssueRelation:
    "scalars plus `issue`/`relatedIssue`, which are NON-NULLABLE single Issues: the filter cannot null them, so the walk must deny them (second table)",
  IssueSharedAccess:
    "scalars plus `sharedWithUsers: [User!]!` — a collection of METADATA, not of a customer-scoped type",
  Organization:
    "workspace-wide settings; every collection it exposes (integrations, labels, projectLabels, teams, templates, users) has a metadata or denied node type — no customer-scoped collection",
  PageInfo: "four cursor scalars, no relations",
  Project:
    "delivery container shared across customers; `convertedFromIssue` is a nullable single, but `comments`, `issues` and `needs` are collections of customer-scoped types — see the table below",
  ProjectMilestone:
    "project-owned marker; `project` and `documentContent` are singles, `issues` is an IssueConnection — collection, see the table below",
  ProjectUpdate:
    "a status post ON a project — the project's own health over time, so it inherits `Project`'s classification: the body is the team's report on delivery, not a customer's data, and a project spans customers anyway; `project` and `user` are metadata singles, `reactions` a list of METADATA, and `comments` is a CommentConnection — collection, see the table below",
  Reaction:
    "an emoji row; `comment` and `issue` are NULLABLE singles the response filter can null out, everything else is a metadata single or a scalar",
  Team: "the workspace unit; every relation is a metadata single except `issues`, an IssueConnection — the M2 escape, now visible by type (see the table below)",
  Template:
    "reusable issue/project skeleton; relations are metadata singles, no collections, `templateData` was EXCLUDED as an unnameable `Record<string, unknown>`",
  User: "a workspace member; profile fields are scalars, but `assignedIssues`, `createdIssues` and `delegatedIssues` are IssueConnections — collections, see the table below",
  WorkflowState:
    "a column in a team's workflow; `team`/`inheritedFrom` are metadata singles, `issues` is an IssueConnection — collection, see the table below",
  AttachmentConnection: "Relay shell over Attachment; the node type carries the scope",
  CommentConnection: "Relay shell over Comment; the node type carries the scope",
  CustomerConnection: "Relay shell over Customer; the node type carries the scope",
  CustomerNeedConnection:
    "Relay shell over CustomerNeed; the node type carries the scope",
  CycleConnection: "Relay shell over Cycle (metadata)",
  ExternalUserConnection: "Relay shell over ExternalUser (metadata)",
  FavoriteConnection: "Relay shell over Favorite (metadata)",
  IssueConnection: "Relay shell over Issue; the node type carries the scope",
  IssueLabelConnection: "Relay shell over IssueLabel (metadata)",
  IssueRelationConnection: "Relay shell over IssueRelation (metadata)",
  ProjectConnection: "Relay shell over Project (metadata)",
  ProjectMilestoneConnection: "Relay shell over ProjectMilestone (metadata)",
  TeamConnection: "Relay shell over Team (metadata)",
  TemplateConnection: "Relay shell over Template (metadata)",
  UserConnection: "Relay shell over User (metadata)",
  WorkflowStateConnection: "Relay shell over WorkflowState (metadata)",
};

/**
 * The Relay shells whose `nodes` are customer-scoped. These are NOT an escape:
 * a connection has no reachability of its own, it inherits its parent's — so
 * `issues { nodes { … } }` at the root is the narrowed read, while the same
 * shell under `Team.issues` is denied by the table below. Pinned so the split
 * between "shell" and "metadata object" stays deliberate.
 */
export const CUSTOMER_SCOPED_CONNECTIONS: readonly string[] = [
  "AttachmentConnection",
  "CommentConnection",
  "CustomerConnection",
  "CustomerNeedConnection",
  "IssueConnection",
];

/**
 * The metadata OBJECT types that expose a collection of a customer-scoped type.
 * They stay metadata — the type itself is furniture — but Task 2's walk must
 * deny these exact fields: a collection cannot be repaired by nulling, and
 * following one re-expands to the whole workspace (`team { issues { … } }` is
 * the escape M2 closed by path, and closes by type from here on).
 */
export const METADATA_CUSTOMER_COLLECTIONS: Readonly<
  Record<string, readonly string[]>
> = {
  Cycle: ["issues", "uncompletedIssuesUponClose"],
  InitiativeUpdate: ["comments"],
  IssueLabel: ["issues"],
  Project: ["comments", "issues", "needs"],
  ProjectMilestone: ["issues"],
  ProjectUpdate: ["comments"],
  Team: ["issues"],
  User: ["assignedIssues", "createdIssues", "delegatedIssues"],
  WorkflowState: ["issues"],
};

/**
 * The other unfilterable shape: a NON-NULLABLE single customer-scoped object
 * hanging off a metadata type. The response filter cannot replace it with
 * `null` without breaking the vendor schema (the SDK would crash on it), so
 * the walk must refuse it up front.
 */
export const METADATA_NON_NULLABLE_CUSTOMER_SINGLES: Readonly<
  Record<string, readonly string[]>
> = {
  IssueRelation: ["issue", "relatedIssue"],
};

/**
 * How to reach the owning customer id from an object of that type.
 *
 * `@linear/sdk` 90 declares NO `Issue.customer` field and NO
 * `IssueFilter.customer` input: the customer link runs through `Issue.needs` →
 * `CustomerNeed.customer`, a COLLECTION. An issue can therefore belong to
 * several customers at once, and the `"*"` segment says so — the object is ours
 * when ANY need names the mission's customer (SPEC §4.4.3, decided permissive).
 * The other needs are customer-scoped objects with their own rule and are
 * removed on the way out, so a shared issue passes without naming who shares it.
 *
 * `Comment.issue` and `Attachment.issue` route through the same collection. A
 * comment on a project rather than an issue resolves no owner at all, which is
 * FOREIGN — fail closed, not a pass.
 */
const ISSUE_OWNER: readonly string[] = ["needs", "nodes", "*", "customer", "id"];

const OWNER_PATHS: Readonly<Record<string, readonly string[]>> = {
  Attachment: ["issue", ...ISSUE_OWNER],
  Comment: ["issue", ...ISSUE_OWNER],
  Customer: ["id"],
  // `CustomerNeed.customer` is a declared (nullable) relation, so an
  // unresolvable owner makes the need foreign — which is what removes the needs
  // of the OTHER customers on an issue the mission may see.
  CustomerNeed: ["customer", "id"],
  Issue: ISSUE_OWNER,
};

const CUSTOMER_SCOPED = new Set(CUSTOMER_SCOPED_TYPES);
const METADATA = new Set(METADATA_TYPES);

/**
 * Unknown ⇒ `"denied"`, always. Leaf types (scalars, enums, `Date`) answer
 * `"metadata"`: they carry no fields, so a selection set under one resolves
 * nothing and dies anyway — while a `"denied"` answer would refuse
 * `issue { title }`.
 *
 * A UNION answers for all of its members at once: `"metadata"` when every
 * member is metadata, `"denied"` otherwise. That is decidable from the artifact
 * and it is the only reading that stays fail-closed — a union is entered
 * through `... on <Member>`, so one customer-scoped or unclassified member would
 * otherwise be reachable behind a name that looked safe.
 */
export function typeClass(type: string): TypeClass {
  if (CUSTOMER_SCOPED.has(type)) return "customer-scoped";
  if (METADATA.has(type)) return "metadata";
  if (leafType(type)) return "metadata";
  const members = unionMembers(type);
  if (members === undefined) return "denied";
  return members.every((member) => typeClass(member) === "metadata")
    ? "metadata"
    : "denied";
}

/** The route to the owning customer id, or `undefined` — which is a deny. */
export function ownerPath(type: string): readonly string[] | undefined {
  return Object.hasOwn(OWNER_PATHS, type) ? OWNER_PATHS[type] : undefined;
}
