import type { Exchange } from "./classify";
import { assumption, type Assumption, type GithubCredential } from "./harness";
import { call, pace } from "./http";
import { rememberAll } from "./writable";
import { announced } from "./upstream";

/**
 * HALF A, GitHub — the routes the catalog allows, and the one path-encoding
 * fact the connector's canonicalization exists for.
 *
 * `%2F` is not a curiosity. `narrow-path.ts` decodes every path before deciding
 * on it BECAUSE api.github.com reads `%2F` as a separator: deciding on the raw
 * segments would let `/repos/acme/product/..%2f..%2fglobex/x` read as a path
 * inside `acme/product`. If the vendor stopped decoding it, the connector would
 * be canonicalizing a request the vendor no longer canonicalizes the same way —
 * which is the direction that matters, and the reason this is checked live.
 */

export const GITHUB_URL = "https://api.github.com";
const CATALOG_FILE = "packages/connectors-github/src/catalog.ts";
const NARROW_PATH_FILE = "packages/connectors-github/src/narrow-path.ts";
const PACE_MS = 300;

export interface GithubTargets {
  repo: string;
  /** An issue number of that repo, if it has one. */
  issueNumber?: string;
  /** A pull-request number, if it has one. */
  pullNumber?: string;
  /** A file at least one directory deep, as `dir/file` — for the `%2F` check. */
  nestedPath?: string;
}

export async function githubCall(
  credential: GithubCredential,
  label: string,
  path: string,
): Promise<Exchange> {
  await pace(PACE_MS);
  return call(
    announced(label, {
      method: "GET",
      url: `${GITHUB_URL}${path}`,
      headers: {
        authorization: `Bearer ${credential.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "missura-compat",
      },
    }),
  );
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `number` off the first element of a top-level array — an issue or a PR. */
function firstNumber(body: string): string | undefined {
  const parsed = parse(body);
  if (!Array.isArray(parsed)) return undefined;
  const first: unknown = parsed[0];
  if (!isRecord(first) || typeof first.number !== "number") return undefined;
  return String(first.number);
}

/** The first entry of a contents listing whose `type` matches. */
function firstEntry(body: string, type: string): string | undefined {
  const parsed = parse(body);
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    if (entry.type === type && typeof entry.path === "string") return entry.path;
  }
  return undefined;
}

/**
 * An issue, a pull request and a nested file of the mission's repo. Every one
 * of them may be absent — a repo with no PRs is a normal repo — and an absent
 * one turns its check UNVERIFIABLE rather than failing it.
 */
export async function discoverGithubTargets(
  credential: GithubCredential,
): Promise<GithubTargets> {
  const repo = credential.repo;
  const issues = await githubCall(
    credential,
    "github · discover one issue",
    `/repos/${repo}/issues?per_page=1&state=all`,
  );
  const pulls = await githubCall(
    credential,
    "github · discover one pull request",
    `/repos/${repo}/pulls?per_page=1&state=all`,
  );
  const root = await githubCall(
    credential,
    "github · discover a directory at the repo root",
    `/repos/${repo}/contents`,
  );
  const directory = firstEntry(root.body, "dir");
  let nested: string | undefined;
  if (directory !== undefined) {
    const inside = await githubCall(
      credential,
      "github · discover a file inside that directory",
      `/repos/${repo}/contents/${directory}`,
    );
    nested = firstEntry(inside.body, "file");
  }
  const issueNumber = firstNumber(issues.body);
  const pullNumber = firstNumber(pulls.body);
  const targets: GithubTargets = {
    repo,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(pullNumber === undefined ? {} : { pullNumber }),
    ...(nested === undefined ? {} : { nestedPath: nested }),
  };
  // A path inside the repository is the tenant's, and it is the one discovered
  // value no structural rule could recognize (`writable.ts`).
  rememberAll({ ...targets });
  return targets;
}

/** The catalogued routes, as `operation → path`, with the discovered ids bound. */
export function githubRoutes(
  targets: GithubTargets,
): readonly (readonly [string, string | undefined])[] {
  const repo = targets.repo;
  const issue = targets.issueNumber;
  const pull = targets.pullNumber;
  return [
    ["repos.get", `/repos/${repo}`],
    ["repos.issues.list", `/repos/${repo}/issues?per_page=1&state=all`],
    ["repos.issues.get", issue === undefined ? undefined : `/repos/${repo}/issues/${issue}`],
    [
      "repos.issues.comments.list",
      issue === undefined
        ? undefined
        : `/repos/${repo}/issues/${issue}/comments?per_page=1`,
    ],
    ["repos.pulls.list", `/repos/${repo}/pulls?per_page=1&state=all`],
    ["repos.pulls.get", pull === undefined ? undefined : `/repos/${repo}/pulls/${pull}`],
    ["repos.contents.get", `/repos/${repo}/contents`],
    ["search.issues", `/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue`)}&per_page=1`],
  ];
}

function routeAssumption(
  operation: string,
  path: string,
  exchange: Exchange,
): Assumption {
  const base = {
    id: `github.route.${operation}`,
    vendor: "github" as const,
    claim: `the catalogued route \`${operation}\` still exists`,
    encodedIn: CATALOG_FILE,
  };
  if (exchange.status === 200) {
    return assumption(base, "HOLDS", `${path.split("?")[0] ?? path} answered 200`);
  }
  if (exchange.status === 404 || exchange.status === 410) {
    return assumption(
      base,
      "BROKEN",
      `${path.split("?")[0] ?? path} answered ${String(exchange.status)} — the catalog names a route this token cannot reach`,
    );
  }
  return assumption(
    base,
    "UNVERIFIABLE",
    `${path.split("?")[0] ?? path} answered ${String(exchange.status)} — neither an answer nor an absence`,
  );
}

/**
 * `%2F` inside a `contents` path still resolves as a separator: the file is
 * returned, and the `path` it reports back is the SLASHED one. The second half
 * is the real assertion — a 200 alone could be any file.
 */
async function encodedSlash(
  credential: GithubCredential,
  targets: GithubTargets,
): Promise<Assumption> {
  const base = {
    id: "github.contents.encoded-slash",
    vendor: "github" as const,
    claim:
      "`%2F` inside a `contents` path is decoded by the vendor as a path separator, which is why the connector decides on the DECODED segments",
    encodedIn: NARROW_PATH_FILE,
  };
  const nested = targets.nestedPath;
  if (nested?.includes("/") !== true) {
    return assumption(
      base,
      "UNVERIFIABLE",
      "this repo has no file at least one directory deep, so there is nothing to encode a separator inside of",
    );
  }
  const encoded = nested.split("/").map(encodeURIComponent).join("%2F");
  const exchange = await githubCall(
    credential,
    "github · read a nested file through an encoded separator",
    `/repos/${targets.repo}/contents/${encoded}`,
  );
  const parsed = parse(exchange.body);
  const reported =
    isRecord(parsed) && typeof parsed.path === "string" ? parsed.path : undefined;
  if (exchange.status !== 200) {
    return assumption(
      base,
      "BROKEN",
      `a path whose separators are written \`%2F\` answered ${String(exchange.status)} — the vendor no longer decodes it, and the connector is canonicalizing a request the vendor reads differently`,
    );
  }
  return assumption(
    base,
    reported === nested ? "HOLDS" : "BROKEN",
    reported === nested
      ? "the encoded path answered 200 and the file reports back the slashed path — the vendor decoded `%2F` as a separator"
      : `the encoded path answered 200 but reports a different path than the slashed one — the vendor resolved it to something else`,
  );
}

export async function githubAssumptions(
  credential: GithubCredential,
  targets: GithubTargets,
): Promise<Assumption[]> {
  const out: Assumption[] = [];
  for (const [operation, path] of githubRoutes(targets)) {
    if (path === undefined) {
      out.push(
        assumption(
          {
            id: `github.route.${operation}`,
            vendor: "github",
            claim: `the catalogued route \`${operation}\` still exists`,
            encodedIn: CATALOG_FILE,
          },
          "UNVERIFIABLE",
          "this repo has no object to aim that route at",
        ),
      );
      continue;
    }
    out.push(
      routeAssumption(
        operation,
        path,
        await githubCall(credential, `github · ${operation}`, path),
      ),
    );
  }
  out.push(await encodedSlash(credential, targets));
  return out;
}
