/**
 * The Zendesk endpoint families missura decided never to proxy, and why.
 *
 * These are not "not implemented yet". Deny by default already refuses an
 * uncataloged path; what this table adds is a NAME. A denial reason is the only
 * breadcrumb a fail-closed system leaves, and "not in the catalog" reads the
 * same for a typo and for a deliberate product decision — so the decisions get
 * their own reasons, and a future catalog entry has to argue with one of them
 * rather than quietly appear next to it.
 *
 * Every path was checked against developer.zendesk.com.
 */

export interface Refusal {
  /** Operation recorded in the decision log — never `unknown`. */
  readonly operation: string;
  readonly reason: string;
}

export interface PrefixRefusal extends Refusal {
  /** Leading path segments, matched in order from the root. */
  readonly segments: readonly string[];
}

export interface SegmentRefusal extends Refusal {
  /** A segment that refuses the path wherever in it the segment appears. */
  readonly segment: string;
}

const INCREMENTAL: Refusal = {
  operation: "refused.incremental_exports",
  reason:
    "incremental exports are never allowed: `/api/v2/incremental/*` streams every ticket, user and organization in the account, takes no organization parameter, and its cursor walks the whole stream — there is no scope to inject and nothing to narrow",
};

const JOB_STATUSES: Refusal = {
  operation: "refused.job_statuses",
  reason:
    "job statuses are never allowed: `/api/v2/job_statuses` reports on the bulk jobs missura does not proxy, and a job id is not an object that carries an organization",
};

const BULK: Refusal = {
  operation: "refused.bulk",
  reason:
    "bulk, batch and export endpoints are never allowed: they answer for many objects at once across the whole account (`show_many`, `create_many`, `update_many`, `destroy_many`, `/api/v2/search/export`), which is a shape missura refuses outright rather than filters",
};

const ADMIN: Refusal = {
  operation: "refused.admin",
  reason:
    "administration and user-management endpoints are never allowed: they configure the account — its agents, roles, groups, business rules, apps and audit trail — rather than read a customer's tickets, and none of them carries an organization to scope by",
};

const ATTACHMENTS: Refusal = {
  operation: "refused.attachments",
  reason:
    "attachment and file-download endpoints are never allowed: an attachment's `content_url` points at a host outside this connection (Zendesk's own docs warn the file may be hosted externally), and missura does not proxy a second hop it cannot filter",
};

const UNSCOPED_LISTING: Refusal = {
  operation: "refused.unscoped_listing",
  reason:
    "an account-wide listing is never allowed: Zendesk publishes organization-scoped forms of it (`/api/v2/organizations/{id}/tickets`, `/api/v2/organizations/{id}/users`), so the unscoped one would make filtering the first control instead of the second",
};

/**
 * Matched in order, and BEFORE the allowlist: `/api/v2/organizations/show_many`
 * and `/api/v2/users/me` both fit the shape of an allowed route, and a generic
 * "not in the catalog" would hide which decision refused them.
 */
export const PREFIX_REFUSALS: readonly PrefixRefusal[] = [
  { segments: ["api", "v2", "incremental"], ...INCREMENTAL },
  { segments: ["api", "v2", "job_statuses"], ...JOB_STATUSES },
  { segments: ["api", "v2", "search", "export"], ...BULK },
  { segments: ["api", "v2", "exports"], ...BULK },
  { segments: ["api", "v2", "tickets"], ...UNSCOPED_LISTING },
  { segments: ["api", "v2", "users"], ...UNSCOPED_LISTING },

  // Account and credential surfaces.
  { segments: ["api", "v2", "account"], ...ADMIN },
  { segments: ["api", "v2", "oauth"], ...ADMIN },
  { segments: ["api", "v2", "api_tokens"], ...ADMIN },
  { segments: ["api", "v2", "sessions"], ...ADMIN },
  { segments: ["api", "v2", "audit_logs"], ...ADMIN },
  { segments: ["api", "v2", "brands"], ...ADMIN },
  { segments: ["api", "v2", "apps"], ...ADMIN },
  { segments: ["api", "v2", "webhooks"], ...ADMIN },
  { segments: ["api", "v2", "targets"], ...ADMIN },
  { segments: ["api", "v2", "sharing_agreements"], ...ADMIN },

  // User and membership management.
  { segments: ["api", "v2", "organization_memberships"], ...ADMIN },
  { segments: ["api", "v2", "organization_subscriptions"], ...ADMIN },
  { segments: ["api", "v2", "group_memberships"], ...ADMIN },
  { segments: ["api", "v2", "groups"], ...ADMIN },
  { segments: ["api", "v2", "custom_roles"], ...ADMIN },
  { segments: ["api", "v2", "permission_groups"], ...ADMIN },

  // Business rules and moderation queues.
  { segments: ["api", "v2", "triggers"], ...ADMIN },
  { segments: ["api", "v2", "automations"], ...ADMIN },
  { segments: ["api", "v2", "macros"], ...ADMIN },
  { segments: ["api", "v2", "views"], ...ADMIN },
  { segments: ["api", "v2", "deleted_tickets"], ...ADMIN },
  { segments: ["api", "v2", "suspended_tickets"], ...ADMIN },
];

/**
 * Refused wherever the segment appears, because these families hang off other
 * resources: `/api/v2/users/{id}/identities`,
 * `/api/v2/tickets/{id}/comments/{id}/attachments/{id}/redact`.
 */
export const SEGMENT_REFUSALS: readonly SegmentRefusal[] = [
  { segment: "show_many", ...BULK },
  { segment: "create_many", ...BULK },
  { segment: "update_many", ...BULK },
  { segment: "destroy_many", ...BULK },
  { segment: "create_or_update_many", ...BULK },
  { segment: "destroy_bulk", ...BULK },
  { segment: "attachments", ...ATTACHMENTS },
  { segment: "uploads", ...ATTACHMENTS },
  { segment: "redact", ...ATTACHMENTS },
  { segment: "identities", ...ADMIN },
  { segment: "me", ...ADMIN },
];

/**
 * The refusal for `segments`, or `undefined` when no decision covers it — which
 * leaves the ordinary deny-by-default reason.
 *
 * Prefixes first: `/api/v2/job_statuses/show_many` is a job status before it is
 * a batch, and the more specific decision is the one worth logging.
 */
export function refusalFor(segments: readonly string[]): Refusal | undefined {
  for (const refusal of PREFIX_REFUSALS) {
    if (refusal.segments.every((seg, i) => seg === segments[i])) {
      // An exact-length match on `tickets`/`users` is the unscoped listing;
      // anything deeper is a different route and must fall through to the
      // allowlist (`/api/v2/tickets/{id}` is allowed).
      if (
        refusal.operation === UNSCOPED_LISTING.operation &&
        segments.length !== refusal.segments.length
      ) {
        continue;
      }
      return refusal;
    }
  }
  return SEGMENT_REFUSALS.find(({ segment }) => segments.includes(segment));
}
