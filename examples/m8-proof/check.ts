#!/usr/bin/env tsx
/**
 * M8 proof, run by a human against a REAL repository.
 *
 * THIS SCRIPT WRITES. It posts one real comment on one real GitHub issue —
 * the one you name in MISSURA_PROOF_ISSUE — in the repository your mission
 * covers. It never creates an issue, never edits or deletes anything, and
 * makes exactly one write. Run it against a repository you own
 * (`sderosiaux/missura` is the one it was written for).
 *
 * WHAT IT PROVES — the M8 acceptance criterion, live:
 *   - the write happens ONLY through the operation route, and it lands: the
 *     comment posted by `github.issue.comment.create` is read back through
 *     the raw read path, on the vendor, by id;
 *   - the same operation aimed at a repository OUTSIDE the mission is refused
 *     in the not-found shape, decided before the vendor: the refusal carries
 *     missura's own block (a request-side refusal) and relays no vendor
 *     header, and a foreign repository you cannot read answers the same;
 *   - the agent's own POST to the vendor route — same token, same route the
 *     operation used — is refused at the catalog, and the issue's comments
 *     still hold exactly one comment of ours afterwards.
 *
 * SET UP FIRST — all of it, or the checks below FAIL rather than pass:
 *
 *  1. The vault holds a GITHUB_TOKEN that can comment on the repository
 *     (`npx missura init`; a fine-grained token with Issues: write), and YOUR
 *     OWN shell exports no GITHUB_TOKEN: the precondition aborts otherwise.
 *
 *  2. Terminal 1:  missura run
 *
 *  3. Terminal 2 — the mission must cover the repository AND name the
 *     operation; without `--allow` the write is refused and check 3 FAILS:
 *
 *        MISSURA_PROOF_ISSUE=<existing issue number> \
 *          missura exec --repo sderosiaux/missura \
 *            --allow github.issue.comment.create \
 *            --purpose "m8 proof" -- pnpm demo:m8
 *
 * `pnpm demo:m8` sets MISSURA_LIVE=1; without it this script refuses to run.
 * `missura exec` injects MISSION_TOKEN, GITHUB_API_URL, MISSURA_MISSION_URL.
 *
 * Inputs:
 *   MISSURA_PROOF_ISSUE         REQUIRED — the issue to comment on, by number
 *   MISSURA_PROOF_FOREIGN_REPO  a repository NOT in the mission, for check 4
 *                               (default: octocat/hello-world, which exists,
 *                               so the not-found is a refusal, not an absence)
 */
import {
  assertLive,
  assertNoVendorCredentials,
  call,
  check,
  fail,
  githubBase,
  isRecord,
  missionUrl,
  missuraBlock,
  readClaims,
  requireIssue,
  requireToken,
  table,
  type Answer,
  type CheckResult,
} from "./proof";

const OPERATION = "github.issue.comment.create";
const DEFAULT_FOREIGN = "octocat/hello-world";

interface Posted {
  id: number;
  body: string;
}

function postedComment(answer: Answer): Posted {
  const body = answer.json;
  const results: unknown[] =
    isRecord(body) && Array.isArray(body.results) ? (body.results as unknown[]) : [];
  const first = results[0];
  if (!isRecord(first) || typeof first.id !== "number" || typeof first.body !== "string") {
    throw new Error(`no comment in the operation's answer (status ${String(answer.status)}): ${answer.text.slice(0, 200)}`);
  }
  return { id: first.id, body: first.body };
}

/** The comments on the issue since `since`, as the vendor lists them, through the raw read path. */
async function commentsSince(
  token: string,
  repo: string,
  issue: number,
  since: string,
): Promise<Posted[]> {
  const url = `${githubBase()}/repos/${repo}/issues/${String(issue)}/comments?since=${encodeURIComponent(since)}&per_page=100`;
  const res = await call(token, url);
  if (res.status !== 200 || !Array.isArray(res.json)) {
    throw new Error(`reading the comments back answered ${String(res.status)}: ${res.text.slice(0, 200)}`);
  }
  return res.json.flatMap((entry: unknown): Posted[] =>
    isRecord(entry) && typeof entry.id === "number" && typeof entry.body === "string"
      ? [{ id: entry.id, body: entry.body }]
      : [],
  );
}

function assertRequestSideNotFound(answer: Answer, what: string): string {
  if (answer.status !== 404) {
    throw new Error(`${what} answered ${String(answer.status)}, expected the not-found 404`);
  }
  const body = answer.json;
  if (!isRecord(body) || body.message !== "Not Found") {
    throw new Error(`${what} is not GitHub's own not-found shape: ${answer.text.slice(0, 200)}`);
  }
  const block = missuraBlock(answer);
  if (block?.code !== "missura_out_of_mission_scope") {
    throw new Error(`${what} carries no request-side missura block: ${answer.text.slice(0, 200)}`);
  }
  // A refusal decided AFTER the vendor answered carries the vendor's bare
  // not-found and its headers; one decided BEFORE carries the block and
  // relays nothing. The block plus the missing request id is what "no vendor
  // call" looks like from outside.
  if (answer.headers.get("x-github-request-id") !== null) {
    throw new Error(`${what} relayed a vendor request id — the vendor was reached`);
  }
  return "404 Not Found, missura_out_of_mission_scope, no vendor header relayed";
}

async function main(): Promise<void> {
  assertLive();
  const envDetail = assertNoVendorCredentials();
  const token = requireToken();
  const issue = requireIssue();
  const claims = readClaims(token);
  const repo = claims.repos[0];
  if (repo === undefined) fail("this mission covers no repository — mint one with --repo owner/name");
  const foreign = (process.env.MISSURA_PROOF_FOREIGN_REPO ?? "").trim() || DEFAULT_FOREIGN;
  if (claims.repos.map((r) => r.toLowerCase()).includes(foreign.toLowerCase())) {
    fail(`MISSURA_PROOF_FOREIGN_REPO ${foreign} is IN the mission — name one outside it`);
  }
  const marker = `missura m8 proof — ${new Date().toISOString()} — ${Math.random().toString(36).slice(2, 8)}`;
  const since = new Date(Date.now() - 60_000).toISOString();

  process.stderr.write(
    `mission ${claims.id} — ${claims.purpose} (${claims.actor})\nrepo ${repo}, issue #${String(issue)}, foreign ${foreign}\n\n`,
  );
  const results: CheckResult[] = [
    { name: "1 · env carries no vendor credential", status: "PASS", detail: envDetail },
  ];

  await check(results, "2 · introspection lists the write, by name and effect", async () => {
    const res = await call(token, missionUrl());
    const ops = isRecord(res.json) && Array.isArray(res.json.operations) ? res.json.operations : [];
    const listed = ops.some(
      (op: unknown) => isRecord(op) && op.name === OPERATION && op.effect === "append",
    );
    if (!listed) {
      throw new Error(`not listed — re-run under: missura exec --repo ${repo} --allow ${OPERATION} …`);
    }
    return `{name: ${OPERATION}, effect: append}`;
  });

  let posted: Posted | undefined;
  await check(results, "3 · the operation posts ONE comment, credentialed by the vault", async () => {
    const res = await call(token, `${githubBase()}/missura/op/${OPERATION}`, {
      method: "POST",
      body: { repo, issue, body: marker },
    });
    if (res.status !== 200) {
      throw new Error(`operation answered ${String(res.status)}: ${res.text.slice(0, 300)}`);
    }
    posted = postedComment(res);
    if (posted.body !== marker) throw new Error("the vendor's comment does not carry the body sent");
    return `comment ${String(posted.id)} on ${repo}#${String(issue)}`;
  });

  await check(results, "4 · the comment is there, read back through the raw read path", async () => {
    if (posted === undefined) throw new Error("nothing was posted");
    const id = posted.id;
    const ours = (await commentsSince(token, repo, issue, since)).filter((c) => c.body === marker);
    if (!ours.some((c) => c.id === id)) {
      throw new Error(`comment ${String(id)} not found among the issue's comments since ${since}`);
    }
    return `GET /repos/${repo}/issues/${String(issue)}/comments lists ${String(id)}`;
  });

  await check(results, "5 · the same write on a repo outside the mission: not-found, before the vendor", async () => {
    const res = await call(token, `${githubBase()}/missura/op/${OPERATION}`, {
      method: "POST",
      body: { repo: foreign, issue: 1, body: marker },
    });
    const detail = assertRequestSideNotFound(res, `the write on ${foreign}`);
    // The same bytes a READ of that foreign repository gets, code and shape.
    const read = await call(token, `${githubBase()}/repos/${foreign}/issues/1`);
    assertRequestSideNotFound(read, `a read of ${foreign}`);
    return `${detail}; a raw read of it answers the same shape`;
  });

  await check(results, "6 · the raw path never writes: the agent's own POST is refused, nothing lands", async () => {
    const res = await call(token, `${githubBase()}/repos/${repo}/issues/${String(issue)}/comments`, {
      method: "POST",
      body: { body: `${marker} — via the raw route` },
    });
    const block = missuraBlock(res);
    if (res.status !== 403 || block?.code !== "missura_operation_not_in_catalog") {
      throw new Error(`raw POST answered ${String(res.status)} ${String(block?.code)}: ${res.text.slice(0, 200)}`);
    }
    const ours = (await commentsSince(token, repo, issue, since)).filter((c) =>
      c.body.startsWith(marker),
    );
    if (ours.length !== 1) {
      throw new Error(`${String(ours.length)} comment(s) of ours on the issue — expected exactly the operation's one`);
    }
    return "403 missura_operation_not_in_catalog; the issue holds exactly one comment of ours";
  });

  process.stdout.write(`${table(results)}\n`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (failed > 0) {
    process.stderr.write(`\n${String(failed)} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\nM8 proof: no check failed — one comment written, everything else refused before the vendor\n`);
}

await main();
