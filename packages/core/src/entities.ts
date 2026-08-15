import { existsSync, readFileSync } from "node:fs";
import type { MissionScope } from "./token";

/**
 * What a business entity means in vendor terms. The mission speaks business
 * ("customer:acme"); only this map turns that into vendor ids, so a mission
 * never carries — nor can it forge — a raw vendor identifier.
 */
export interface EntityMapping {
  linearCustomerId?: string;
  githubRepos?: string[];
}

export interface ResolvedScope {
  linearCustomerId?: string;
  githubRepos: string[];
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRepos(key: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((r) => typeof r !== "string")) {
    throw new Error(
      `entity "${key}": "github.repos" must be an array of strings`,
    );
  }
  const repos = value as string[];
  for (const repo of repos) {
    if (!REPO_RE.test(repo)) {
      throw new Error(
        `entity "${key}": invalid repo "${repo}", expected owner/name`,
      );
    }
  }
  return repos;
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

function assertRepo(repo: string): string {
  if (!REPO_RE.test(repo)) {
    throw new Error(`invalid repo "${repo}", expected owner/name`);
  }
  return repo;
}

/**
 * Turns a mission scope into vendor targets. An unknown customer throws rather
 * than resolving to nothing: a mission whose entity vanished must fail to be
 * minted, not quietly become an unscoped one.
 */
export function resolveScope(
  map: Map<string, EntityMapping>,
  scope: MissionScope,
): ResolvedScope {
  const resolved: ResolvedScope = { githubRepos: [] };
  const seen = new Set<string>();
  const add = (repo: string): void => {
    const key = repo.toLowerCase();
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
  for (const repo of scope.repos ?? []) add(assertRepo(repo));
  return resolved;
}
