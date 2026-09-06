#!/usr/bin/env tsx
/**
 * M10 proof, run by a human against a REAL repository.
 *
 * THIS SCRIPT DELETES. It removes one real comment from one real GitHub
 * issue — the comment whose id you give in MISSURA_PROOF_COMMENT, in the
 * repository your mission covers — and it does so for good. It creates
 * nothing and touches nothing else. The comment `pnpm demo:m8` posted is
 * the one it was written to clean up.
 *
 * WHAT IT PROVES — the M10 acceptance criterion, live, with this script
 * playing BOTH parts: the agent (mission token, data plane) and the
 * operator (operator key, operator plane). Nothing either part holds can do
 * the other's job.
 *   - a `destroy` does not run on request: the operation answers `202` and
 *     an approval id, and the comment is still there, read back raw;
 *   - approving on the operator plane runs nothing: after the approval the
 *     comment is STILL there, and the poll reads `approved`;
 *   - the agent's re-request with the id runs it once: the comment is gone,
 *     read back raw, and a second re-request with the same id is refused.
 *
 * SET UP FIRST — all of it, or the checks below FAIL rather than pass:
 *
 *  1. The vault holds a GITHUB_TOKEN that can delete comments on the
 *     repository (`npx missura init`; a fine-grained token with Issues:
 *     write), and YOUR OWN shell exports no GITHUB_TOKEN.
 *
 *  2. Terminal 1:  missura run
 *     (the operator plane on 8480 — set MISSURA_OPERATOR_URL if you moved it,
 *     and MISSURA_HOME if the install is not ~/.missura: the operator key is
 *     read from there)
 *
 *  3. Terminal 2 — the mission must cover the repository AND name the
 *     operation; without `--allow` check 4 FAILS with the allow denial:
 *
 *        MISSURA_PROOF_COMMENT=<comment id> \
 *          missura exec --repo sderosiaux/missura \
 *            --allow github.issue.comment.delete \
 *            --purpose "m10 proof" -- pnpm demo:m10
 *
 * `pnpm demo:m10` sets MISSURA_LIVE=1; without it this script refuses to run.
 * `missura exec` injects MISSION_TOKEN, GITHUB_API_URL, MISSURA_MISSION_URL.
 *
 * Inputs:
 *   MISSURA_PROOF_COMMENT   REQUIRED — the issue comment to delete, by id
 *                           (`pnpm demo:m8` prints the one it created)
 *   MISSURA_OPERATOR_URL    the operator plane (default http://127.0.0.1:8480)
 *   MISSURA_HOME            where operator.key lives (default ~/.missura)
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
  operatorCall,
  readClaims,
  requireComment,
  requireToken,
  table,
  type Answer,
  type CheckResult,
} from "./proof";

const OPERATION = "github.issue.comment.delete";
const ACTOR = "m10-proof@local";

function approvalOf(answer: Answer): { id: string; state: string } {
  const body = answer.json;
  if (!isRecord(body) || typeof body.id !== "string" || typeof body.state !== "string") {
    throw new Error(`no approval in the answer (status ${String(answer.status)}): ${answer.text.slice(0, 200)}`);
  }
  return { id: body.id, state: body.state };
}

async function main(): Promise<void> {
  assertLive();
  const envDetail = assertNoVendorCredentials();
  const token = requireToken();
  const comment = requireComment();
  const claims = readClaims(token);
  const repo = claims.repos[0];
  if (repo === undefined) fail("this mission covers no repository — mint one with --repo owner/name");
  const commentUrl = `${githubBase()}/repos/${repo}/issues/comments/${String(comment)}`;
  const opUrl = `${githubBase()}/missura/op/${OPERATION}`;
  const params = { repo, comment };

  process.stderr.write(
    `mission ${claims.id} — ${claims.purpose} (${claims.actor})\nrepo ${repo}, comment ${String(comment)}\n\n`,
  );
  const results: CheckResult[] = [
    { name: "1 · env carries no vendor credential", status: "PASS", detail: envDetail },
  ];

  await check(results, "2 · introspection lists the destroy, by name and effect", async () => {
    const res = await call(token, missionUrl());
    const ops = isRecord(res.json) && Array.isArray(res.json.operations) ? res.json.operations : [];
    const listed = ops.some(
      (op: unknown) => isRecord(op) && op.name === OPERATION && op.effect === "destroy",
    );
    if (!listed) {
      throw new Error(`not listed — re-run under: missura exec --repo ${repo} --allow ${OPERATION} …`);
    }
    return `{name: ${OPERATION}, effect: destroy}`;
  });

  await check(results, "3 · the comment exists, read through the raw read path", async () => {
    const res = await call(token, commentUrl);
    if (res.status !== 200) {
      throw new Error(`GET the comment answered ${String(res.status)}: ${res.text.slice(0, 200)}`);
    }
    return `GET /repos/${repo}/issues/comments/${String(comment)} → 200`;
  });

  let approval: { id: string; state: string } | undefined;
  await check(results, "4 · the operation answers 202 and an approval id — and the comment is still there", async () => {
    const res = await call(token, opUrl, { method: "POST", body: params });
    if (res.status !== 202) {
      throw new Error(`operation answered ${String(res.status)}: ${res.text.slice(0, 300)}`);
    }
    approval = approvalOf(res);
    if (approval.state !== "pending") throw new Error(`state is ${approval.state}, expected pending`);
    const still = await call(token, commentUrl);
    if (still.status !== 200) throw new Error(`the comment answered ${String(still.status)} after the 202`);
    return `202 {id: ${approval.id}, state: pending}; the comment still answers 200`;
  });

  await check(results, "5 · the poll reads pending", async () => {
    if (approval === undefined) throw new Error("no approval was opened");
    const res = await call(token, `${githubBase()}/missura/approvals/${approval.id}`);
    const polled = approvalOf(res);
    if (res.status !== 200 || polled.state !== "pending") {
      throw new Error(`poll answered ${String(res.status)} ${polled.state}`);
    }
    return `GET /missura/approvals/${approval.id} → pending`;
  });

  await check(results, "6 · the OPERATOR approves on the operator plane — and nothing runs: the comment is still there", async () => {
    if (approval === undefined) throw new Error("no approval was opened");
    const res = await operatorCall(`/v1/approvals/${approval.id}`, {
      method: "POST",
      body: { decision: "approved", actor: ACTOR },
    });
    if (res.status !== 200) {
      throw new Error(`the operator plane answered ${String(res.status)}: ${res.text.slice(0, 200)}`);
    }
    const still = await call(token, commentUrl);
    if (still.status !== 200) {
      throw new Error(`the comment answered ${String(still.status)} right after the approval — something ran`);
    }
    return `POST /v1/approvals/${approval.id} {approved, ${ACTOR}} → 200; the comment still answers 200`;
  });

  await check(results, "7 · the poll reads approved", async () => {
    if (approval === undefined) throw new Error("no approval was opened");
    const res = await call(token, `${githubBase()}/missura/approvals/${approval.id}`);
    const polled = approvalOf(res);
    if (polled.state !== "approved") throw new Error(`poll reads ${polled.state}`);
    return `GET /missura/approvals/${approval.id} → approved`;
  });

  await check(results, "8 · the AGENT re-requests with the id: it runs once, and the comment is gone", async () => {
    if (approval === undefined) throw new Error("no approval was opened");
    const res = await call(token, opUrl, { method: "POST", body: { ...params, approval: approval.id } });
    if (res.status !== 200) {
      throw new Error(`the re-request answered ${String(res.status)}: ${res.text.slice(0, 300)}`);
    }
    const gone = await call(token, commentUrl);
    if (gone.status !== 404) {
      throw new Error(`the comment still answers ${String(gone.status)} after the run`);
    }
    return `200; GET the comment → 404`;
  });

  await check(results, "9 · the same id again is refused, before the vendor", async () => {
    if (approval === undefined) throw new Error("no approval was opened");
    const res = await call(token, opUrl, { method: "POST", body: { ...params, approval: approval.id } });
    const block = missuraBlock(res);
    if (res.status !== 403 || block?.code !== "missura_approval_refused") {
      throw new Error(`answered ${String(res.status)} ${String(block?.code)}: ${res.text.slice(0, 200)}`);
    }
    const poll = approvalOf(await call(token, `${githubBase()}/missura/approvals/${approval.id}`));
    if (poll.state !== "consumed") throw new Error(`poll reads ${poll.state}, expected consumed`);
    return "403 missura_approval_refused; the poll reads consumed";
  });

  process.stdout.write(`${table(results)}\n`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (failed > 0) {
    process.stderr.write(`\n${String(failed)} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(
    `\nM10 proof: no check failed — one comment deleted, after a human, on the agent's own re-request\n`,
  );
}

await main();
