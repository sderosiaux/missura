/**
 * The M7 child and its readers, beside the shared rig (`milestone.fixtures`).
 */

export interface Answer {
  status: number;
  body: string;
  headers: Record<string, string | null>;
}

export interface ProofM7 {
  raw: Answer;
  op: Answer;
  linearOp: Answer;
  linearRaw: Answer;
  mission: { operations: { name: string; effect: string }[] };
}

/** The same ticket list, asked raw and asked as an operation; then Linear both ways. */
export function childM7(organization: string): string {
  return `
const fs = require("node:fs");
const auth = { authorization: "Bearer " + process.env.MISSION_TOKEN };
const call = async (url, init) => {
  const r = await fetch(url, init);
  return {
    status: r.status,
    body: await r.text(),
    headers: {
      "content-type": r.headers.get("content-type"),
      "missura-reduced": r.headers.get("missura-reduced"),
    },
  };
};
(async () => {
  const zd = process.env.ZENDESK_API_URL;
  const out = {
    raw: await call(zd + "/api/v2/organizations/${organization}/tickets.json", { headers: auth }),
    op: await call(zd + "/missura/op/zendesk.tickets.for_entity", { method: "POST", headers: auth }),
    linearOp: await call(process.env.GITHUB_API_URL + "/missura/op/linear.issues.for_entity", {
      method: "POST",
      headers: auth,
    }),
    linearRaw: await call(process.env.LINEAR_API_URL, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ query: "{ issues { nodes { id } } }" }),
    }),
    mission: await (await fetch(process.env.MISSURA_MISSION_URL, { headers: auth })).json(),
  };
  fs.writeFileSync(process.env.MISSURA_HOME + "/proof.json", JSON.stringify(out));
})();
`;
}

/** A refusal body with its clock taken out, and the clock on its own. */
export function unclocked(body: string): { rest: string; expiresIn: number } {
  const parsed = JSON.parse(body) as {
    errors: { extensions: { missura: { mission: { expires_in: number } } } }[];
  };
  const mission = parsed.errors[0]?.extensions.missura.mission;
  if (mission === undefined) throw new Error("no missura block in the refusal");
  const expiresIn = mission.expires_in;
  mission.expires_in = 0;
  return { rest: JSON.stringify(parsed), expiresIn };
}
