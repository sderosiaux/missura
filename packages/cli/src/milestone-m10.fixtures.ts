import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRecord } from "@missura/core";
import type { Harness } from "./harness.fixtures";

/**
 * The M10 child and its readers, beside the shared rig (`milestone.fixtures`).
 * The child cannot decide its own approval, so it hands each id to the test
 * through a file and polls until a human — the test, running `missura
 * approve` / `missura deny` — has spoken.
 */

export interface AnswerM10 {
  status: number;
  body: string;
}

export interface ProofM10 {
  /** The first request: `202`, an approval id. */
  first: AnswerM10;
  /** Polled right away. */
  pending: AnswerM10;
  /** Polled once the test approved it. */
  approved: AnswerM10;
  /** The re-request with the approved id: the one run. */
  run: AnswerM10;
  /** The same id again. */
  again: AnswerM10;
  /** A second request, which the test denies. */
  second: AnswerM10;
  denied: AnswerM10;
  runDenied: AnswerM10;
  /** The egress, inside scope and granted. */
  zendesk: AnswerM10;
  /** The agent's own DELETE on the vendor route. */
  raw: AnswerM10;
  ids: { first: string; second: string; zendesk: string };
  mission: { allow: string[]; operations: { name: string; effect: string }[] };
}

export const M10_DESTROY = "github.issue.comment.delete";
export const M10_EGRESS = "zendesk.ticket.reply";
export const M10_PARAMS = { repo: "acme-corp/product", comment: 9001 };
export const M10_COMMENT_PATH = "/repos/acme-corp/product/issues/comments/9001";

/** The child's own poll loop and the files it hands ids over in. */
const CHILD_PLUMBING = `
const fs = require("node:fs");
const home = process.env.MISSURA_HOME;
const auth = { authorization: "Bearer " + process.env.MISSION_TOKEN };
const json = { ...auth, "content-type": "application/json" };
const call = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.text() };
};
const gh = process.env.GITHUB_API_URL;
const zd = process.env.ZENDESK_API_URL;
const op = (base, name, params) =>
  call(base + "/missura/op/" + name, { method: "POST", headers: json, body: JSON.stringify(params) });
const poll = (id) => call(gh + "/missura/approvals/" + id, { headers: auth });
const handOver = (name, id) => fs.writeFileSync(home + "/" + name + ".json", JSON.stringify({ id }));
const settled = async (id) => {
  for (let i = 0; i < 400; i += 1) {
    const r = await poll(id);
    if (JSON.parse(r.body).state !== "pending") return r;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("approval " + id + " was never decided");
};
`;

/** In order: the flow of the exit criterion, points 1 to 4 and 7. */
export function childM10(): string {
  return `${CHILD_PLUMBING}
(async () => {
  const params = ${JSON.stringify(M10_PARAMS)};
  const first = await op(gh, "${M10_DESTROY}", params);
  const one = JSON.parse(first.body).id;
  const pending = await poll(one);
  handOver("approval-1", one);
  const approved = await settled(one);
  const run = await op(gh, "${M10_DESTROY}", { ...params, approval: one });
  const again = await op(gh, "${M10_DESTROY}", { ...params, approval: one });
  const second = await op(gh, "${M10_DESTROY}", params);
  const two = JSON.parse(second.body).id;
  handOver("approval-2", two);
  const denied = await settled(two);
  const runDenied = await op(gh, "${M10_DESTROY}", { ...params, approval: two });
  const zendesk = await op(zd, "${M10_EGRESS}", { ticket: 35, body: "Thanks — on it." });
  const raw = await call(gh + "${M10_COMMENT_PATH}", { method: "DELETE", headers: auth });
  const mission = await (await fetch(process.env.MISSURA_MISSION_URL, { headers: auth })).json();
  const out = {
    first, pending, approved, run, again, second, denied, runDenied, zendesk, raw, mission,
    ids: { first: one, second: two, zendesk: JSON.parse(zendesk.body).id },
  };
  fs.writeFileSync(home + "/proof.json", JSON.stringify(out));
})();
`;
}

export interface ProofM10Foreign {
  polled: AnswerM10;
  never: AnswerM10;
  run: AnswerM10;
}

/** Point 5: another mission's id, handed over in `MISSURA_FOREIGN_APPROVAL`. */
export function childM10Foreign(): string {
  return `${CHILD_PLUMBING}
(async () => {
  const id = process.env.MISSURA_FOREIGN_APPROVAL;
  const out = {
    polled: await poll(id),
    never: await poll("apr_0000000000000000"),
    run: await op(gh, "${M10_DESTROY}", { repo: "acme-corp/zoetis", comment: 9001, approval: id }),
  };
  fs.writeFileSync(home + "/proof.json", JSON.stringify(out));
})();
`;
}

/** Point 6: the destroy under a mission that does not name it. */
export function childM10Ungranted(): string {
  return `${CHILD_PLUMBING}
(async () => {
  const out = { first: await op(gh, "${M10_DESTROY}", ${JSON.stringify(M10_PARAMS)}) };
  fs.writeFileSync(home + "/proof.json", JSON.stringify(out));
})();
`;
}

/** Polls for a condition, never sleeps blind; fails loudly past the deadline. */
export async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** The id the child handed over under `name`, once it has. */
export async function handedOver(h: Harness, name: string): Promise<string> {
  const file = join(h.home, `${name}.json`);
  await until(() => existsSync(file), `the child's ${name}`);
  return (JSON.parse(readFileSync(file, "utf8")) as { id: string }).id;
}

/** The approvals as the state file holds them: the operator's own record. */
export function approvals(h: Harness): ApprovalRecord[] {
  const state = JSON.parse(readFileSync(join(h.home, "missions.json"), "utf8")) as {
    approvals?: ApprovalRecord[];
  };
  return state.approvals ?? [];
}

/** A refusal with its clock taken out, whichever envelope carries it. */
export function unclockedM10(body: string): string {
  return body.replace(/"expires_in":\d+/g, '"expires_in":0');
}
