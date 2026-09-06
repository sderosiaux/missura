import type { GithubRepoScope } from "./github-scope";

/**
 * WHAT A MISSION IS ENFORCED AGAINST — vendor targets, in each vendor's own
 * spelling, and nothing about how they were arrived at.
 *
 * The mission itself speaks business (`customer:adeo`); only the ENTITY GRAPH
 * turns that into these ids, so a mission never carries — nor can it forge — a
 * raw vendor identifier. Provenance for how the graph got here lives beside it
 * on the mission record (`ScopeProvenance`), never inside this object: what is
 * ENFORCED and what is EXPLAINED are two different things, and blending them is
 * how an explanation ends up widening a grant.
 */
export interface ResolvedScope {
  linearCustomerId?: string;
  githubRepos: GithubRepoScope[];
  /**
   * Zendesk organization ids the mission covers, as strings — Zendesk publishes
   * `organization_id` as a number, and the connector compares it as text.
   *
   * Optional where `githubRepos` is required, because callers that build a
   * `ResolvedScope` by hand would otherwise have to name a field they have
   * nothing to put in. Absent and empty mean the same thing: no Zendesk target,
   * so no zendesk connection.
   */
  zendeskOrganizationIds?: string[];
}
