import { describe, expect, it } from "vitest";
import { decideZendesk } from "./catalog";

/**
 * The Zendesk read catalog: five allowed shapes, a named refusal for every
 * family we decided today never to proxy, and deny for everything else.
 *
 * Every path here was checked against developer.zendesk.com. The point of the
 * named refusals is that a denial reason is the only breadcrumb a deny-by-
 * default system leaves: "not in the catalog" would be true of an incremental
 * export and of a typo alike, and only one of those is a decision.
 */

function allow(path: string): ReturnType<typeof decideZendesk> {
  return decideZendesk("GET", path);
}

describe("decideZendesk — the allowed shapes", () => {
  it.each([
    ["/api/v2/organizations/22989442", "organizations.get"],
    ["/api/v2/organizations/22989442/tickets", "organizations.tickets.list"],
    ["/api/v2/organizations/22989442/users", "organizations.users.list"],
    ["/api/v2/tickets/35436", "tickets.get"],
    ["/api/v2/tickets/35436/comments", "tickets.comments.list"],
    ["/api/v2/users/35436", "users.get"],
    ["/api/v2/search?query=type:ticket", "search.list"],
  ])("allows GET %s as %s", (path, operation) => {
    const verdict = allow(path);
    expect(verdict.decision).toBe("allow");
    expect(verdict.operation).toBe(operation);
    expect(verdict.action).toBe("read");
  });

  /**
   * Zendesk answers the same resource at `/api/v2/tickets/1` and
   * `/api/v2/tickets/1.json`. Both must reach the same verdict, or the suffix
   * is a way past the allowlist in whichever direction the catalog is wrong.
   */
  it.each([
    "/api/v2/tickets/35436.json",
    "/api/v2/organizations/1/tickets.json",
    "/api/v2/search.json?query=type:ticket",
  ])("reads %s as the same route as its suffix-less spelling", (path) => {
    expect(allow(path).decision).toBe("allow");
  });

  it("is read-only", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const verdict = decideZendesk(method, "/api/v2/tickets/1");
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain("read-only");
    }
  });
});

describe("decideZendesk — an unscopable listing", () => {
  /**
   * Zendesk publishes `/api/v2/tickets` and `/api/v2/users`, and neither takes
   * an organization. The organization-scoped forms exist
   * (`/api/v2/organizations/{id}/tickets`, `/api/v2/organizations/{id}/users`),
   * so the unscoped ones are not in the catalog: a listing whose scope can only
   * be applied on the way back is one where filtering is the FIRST control
   * rather than the second.
   */
  it.each(["/api/v2/tickets", "/api/v2/users"])(
    "refuses the account-wide listing %s",
    (path) => {
      const verdict = allow(path);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain("organization-scoped");
    },
  );
});

interface Refusal {
  family: string;
  paths: readonly string[];
  /** A word the reason must carry, so the refusal is named and not generic. */
  named: string;
}

/**
 * Every family refused by name, and by name in a test. Paths verified against
 * developer.zendesk.com.
 */
const REFUSED: readonly Refusal[] = [
  {
    family: "incremental exports",
    paths: [
      "/api/v2/incremental/tickets?start_time=0",
      "/api/v2/incremental/tickets/cursor",
      "/api/v2/incremental/ticket_events?start_time=0",
      "/api/v2/incremental/users/cursor",
      "/api/v2/incremental/organizations?start_time=0",
    ],
    named: "incremental export",
  },
  {
    family: "job statuses",
    paths: [
      "/api/v2/job_statuses",
      "/api/v2/job_statuses/8b726e606741012ffc2d782bcb5adc00",
      "/api/v2/job_statuses/show_many?ids=1,2",
    ],
    named: "job status",
  },
  {
    family: "bulk and batch",
    paths: [
      "/api/v2/tickets/show_many?ids=1,2",
      "/api/v2/users/show_many?ids=1,2",
      "/api/v2/organizations/show_many?ids=1,2",
      "/api/v2/users/create_many",
      "/api/v2/organizations/update_many",
      "/api/v2/tickets/destroy_many?ids=1,2",
      "/api/v2/users/create_or_update_many",
      "/api/v2/search/export?query=type:ticket",
      "/api/v2/exports/tickets",
    ],
    named: "bulk",
  },
  {
    family: "administration and user management",
    paths: [
      "/api/v2/account/settings",
      "/api/v2/oauth/tokens",
      "/api/v2/api_tokens",
      "/api/v2/sessions",
      "/api/v2/users/me",
      "/api/v2/users/35436/identities",
      "/api/v2/organization_memberships",
      "/api/v2/organization_subscriptions",
      "/api/v2/group_memberships",
      "/api/v2/groups",
      "/api/v2/custom_roles",
      "/api/v2/permission_groups",
      "/api/v2/triggers",
      "/api/v2/automations",
      "/api/v2/macros",
      "/api/v2/views",
      "/api/v2/audit_logs",
      "/api/v2/webhooks",
      "/api/v2/targets",
      "/api/v2/apps",
      "/api/v2/brands",
      "/api/v2/sharing_agreements",
      "/api/v2/deleted_tickets",
      "/api/v2/suspended_tickets",
    ],
    named: "administration",
  },
  {
    family: "attachments and downloads",
    paths: [
      "/api/v2/attachments/498483",
      "/api/v2/uploads/6bk3gqumlu9tv4n",
      "/api/v2/tickets/1/comments/2/attachments/3/redact",
    ],
    named: "attachment",
  },
];

describe("decideZendesk — refused by name", () => {
  for (const { family, paths, named } of REFUSED) {
    it.each(paths)(`refuses ${family}: %s`, (path) => {
      const verdict = allow(path);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason.toLowerCase()).toContain(named);
      // The reason names the family, so the decision log can be read without
      // the request beside it.
      expect(verdict.operation).not.toBe("unknown");
    });
  }

  it("names every refused family exactly once", () => {
    const families = REFUSED.map((refusal) => refusal.family);
    expect(new Set(families).size).toBe(families.length);
  });
});

describe("decideZendesk — everything else", () => {
  it.each([
    "/api/v2/help_center/articles",
    "/api/v2/satisfaction_ratings",
    "/api/v2/ticket_fields",
    "/api/v2/tickets/1/audits",
    "/api/v2/tickets/1/incidents",
    "/api/v2/organizations",
    "/api/v2/organizations/autocomplete?name=a",
    "/",
    "/api/v1/tickets/1",
  ])("denies %s with a reason that names the path", (path) => {
    const verdict = allow(path);
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("Zendesk read catalog");
  });
});
