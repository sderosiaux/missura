import type { FilterPlan, FilterRule } from "@missura/core";

/**
 * Test-only bodies and rules for the filter-engine specs. One customer owns
 * `c_18`; anything else in a `customer.id` is another customer's, so "what
 * should survive" is readable straight off the body a test writes.
 */

export const ISSUES: FilterRule = {
  path: ["data", "issues", "nodes", "*"],
  type: "Issue",
  ownerPath: ["customer", "id"],
  expectedOwnerIds: ["c_18"],
  ownerMatch: "exact",
  injected: ["customer"],
  nullable: false,
};

export const ISSUE: FilterRule = {
  path: ["data", "issue"],
  type: "Issue",
  ownerPath: ["customer", "id"],
  expectedOwnerIds: ["c_18"],
  ownerMatch: "exact",
  injected: ["customer"],
  nullable: true,
};

export function plan(
  rules: readonly FilterRule[],
  strip: readonly (readonly string[])[] = [],
): FilterPlan {
  return { rules, strip };
}

export function node(id: string, owner: unknown): Record<string, unknown> {
  return { id, customer: owner };
}

export function list(
  nodes: unknown[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ data: { issues: { nodes, ...extra } } });
}

export function parse(body: string): unknown {
  return JSON.parse(body) as unknown;
}
