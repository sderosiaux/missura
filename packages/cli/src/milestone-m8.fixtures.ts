/**
 * The M8 child and its readers, beside the shared rig (`milestone.fixtures`).
 */

export interface AnswerM8 {
  status: number;
  body: string;
}

export interface ProofM8 {
  /** The write, on the mission's repository. */
  write: AnswerM8;
  /** The same write aimed at a repository outside the mission. */
  foreign: AnswerM8;
  /** A raw READ of that same foreign issue — what the refusal must match. */
  foreignRead: AnswerM8;
  /** The agent's own POST to the vendor route, with the same token. */
  raw: AnswerM8;
  mission: { allow: string[]; operations: { name: string; effect: string }[] };
}

export const M8_OPERATION = "github.issue.comment.create";
export const M8_BODY = "Tracked in Linear — thanks for the report.";

/**
 * In order: the write, the foreign write, the foreign read, the raw POST,
 * then introspection. The order is the proof's: every call after the first
 * must reach no vendor, and the double's call list says whether it did.
 */
export function childM8(): string {
  return `
const fs = require("node:fs");
const auth = { authorization: "Bearer " + process.env.MISSION_TOKEN };
const json = { ...auth, "content-type": "application/json" };
const call = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.text() };
};
const gh = process.env.GITHUB_API_URL;
const op = (params) =>
  call(gh + "/missura/op/${M8_OPERATION}", {
    method: "POST",
    headers: json,
    body: JSON.stringify(params),
  });
(async () => {
  const out = {
    write: await op({ repo: "acme-corp/product", issue: 7, body: ${JSON.stringify(M8_BODY)} }),
    foreign: await op({ repo: "globex/secret", issue: 7, body: ${JSON.stringify(M8_BODY)} }),
    foreignRead: await call(gh + "/repos/globex/secret/issues/7", { headers: auth }),
    raw: await call(gh + "/repos/acme-corp/product/issues/7/comments", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ body: "straight to the vendor" }),
    }),
    mission: await (await fetch(process.env.MISSURA_MISSION_URL, { headers: auth })).json(),
  };
  fs.writeFileSync(process.env.MISSURA_HOME + "/proof.json", JSON.stringify(out));
})();
`;
}

/** A REST refusal with its clock taken out, and the clock on its own. */
export function restUnclocked(body: string): { rest: string; expiresIn: number } {
  const parsed = JSON.parse(body) as {
    missura: { mission: { expires_in: number } };
  };
  const expiresIn = parsed.missura.mission.expires_in;
  parsed.missura.mission.expires_in = 0;
  return { rest: JSON.stringify(parsed), expiresIn };
}
