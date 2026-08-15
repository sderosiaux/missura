import { existsSync, readFileSync } from "node:fs";
import {
  githubRepoScopeKey,
  parseGithubRepoScope,
  type GithubRepoScope,
} from "./github-scope";
import type { MissionScope } from "./token";

/**
 * What a business entity means in vendor terms. The mission speaks business
 * ("customer:acme"); only this map turns that into vendor ids, so a mission
 * never carries — nor can it forge — a raw vendor identifier.
 */
export interface EntityMapping {
  linearCustomerId?: string;
  githubRepos?: GithubRepoScope[];
}

export interface ResolvedScope {
  linearCustomerId?: string;
  githubRepos: GithubRepoScope[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `github.repos` entries are `owner/name` or `owner/name:path/prefix` — see
 * `github-scope.ts` for why that spelling. Parsed here, at load, so a prefix
 * nobody could read fails when the operator edits the file rather than at the
 * first request that would have been decided against it.
 */
function readRepos(key: string, value: unknown): GithubRepoScope[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((r) => typeof r !== "string")) {
    throw new Error(
      `entity "${key}": "github.repos" must be an array of strings`,
    );
  }
  return (value as string[]).map((repo) => {
    try {
      return parseGithubRepoScope(repo);
    } catch (err) {
      throw new Error(
        `entity "${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

function readMapping(key: string, value: unknown): EntityMapping {
  if (!isRecord(value)) {
    throw new Error(`entity "${key}": mapping must be an object`);
  }
  const customer = value["linear.customer"];
  if (customer !== undefined && typeof customer !== "string") {
    throw new Error(`entity "${key}": "linear.customer" must be a string`);
  }
  const repos = readRepos(key, value["github.repos"]);
  const mapping: EntityMapping = {};
  if (customer !== undefined) mapping.linearCustomerId = customer;
  if (repos !== undefined) mapping.githubRepos = repos;
  return mapping;
}

/**
 * Loads `entities.json`. A missing file is a legitimate empty map (no entity
 * configured yet, so every customer scope will be refused downstream); a file
 * we cannot read is an error, never a silent empty map.
 */
export function loadEntityMap(path: string): Map<string, EntityMapping> {
  if (!existsSync(path)) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`entities file ${path} is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`entity map must be a JSON object of entity keys`);
  }
  const map = new Map<string, EntityMapping>();
  for (const [key, value] of Object.entries(parsed)) {
    map.set(key, readMapping(key, value));
  }
  return map;
}

/**
 * Turns a mission scope into vendor targets. An unknown customer throws rather
 * than resolving to nothing: a mission whose entity vanished must fail to be
 * minted, not quietly become an unscoped one.
 *
 * Two entries on the same repository with different path prefixes are two
 * distinct grants and both survive; a bare entry alongside a prefixed one does
 * too, and the connector reads the bare one as the wider grant it is.
 */
export function resolveScope(
  map: Map<string, EntityMapping>,
  scope: MissionScope,
): ResolvedScope {
  const resolved: ResolvedScope = { githubRepos: [] };
  const seen = new Set<string>();
  const add = (repo: GithubRepoScope): void => {
    const key = githubRepoScopeKey(repo);
    if (seen.has(key)) return;
    seen.add(key);
    resolved.githubRepos.push(repo);
  };

  if (scope.customer !== undefined) {
    const key = `customer:${scope.customer}`;
    const mapping = map.get(key);
    if (!mapping) throw new Error(`unknown entity: ${key}`);
    if (mapping.linearCustomerId !== undefined) {
      resolved.linearCustomerId = mapping.linearCustomerId;
    }
    for (const repo of mapping.githubRepos ?? []) add(repo);
  }
  for (const repo of scope.repos ?? []) add(parseGithubRepoScope(repo));
  return resolved;
}
