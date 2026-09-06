/**
 * THE ZENDESK CONNECTION'S TWO HALVES, collected once and kept together.
 *
 * Zendesk is the one connection that owes an ORIGIN as well as a credential:
 * every account lives at its own `https://<subdomain>.zendesk.com`, so there is
 * no default that is not a guess at somebody else's tenant — and a proxy that
 * guessed would inject this account's credential into it.
 *
 * OPTIONAL AS A GROUP, and only as a group. A deployment with no Zendesk boots
 * two listeners and says so; a deployment with two of the three answers is a
 * half-configured connection, which is refused rather than silently dropped —
 * a connection an operator believes exists and does not would surface as "not
 * in your mission" on the one call the agent was minted for.
 *
 * The header is assembled HERE, at init, and stored assembled. The proxy is
 * then handed a credential it forwards rather than three pieces it composes:
 * one place builds it, so there is one place to get it wrong.
 */

import type { CliIo } from "./io";

/** The vault keys. `zendesk` is the credential; the base is not one. */
export const ZENDESK_CREDENTIAL = "zendesk";
export const ZENDESK_BASE = "zendesk.base";

export interface ZendeskConnection {
  /** `Basic <base64>`, ready to forward. Never logged, never printed. */
  authorization: string;
  upstreamBase: string;
}

interface Field {
  envVar: string;
  label: string;
}

const SUBDOMAIN: Field = {
  envVar: "MISSURA_INIT_ZENDESK_SUBDOMAIN",
  label: "Zendesk subdomain (blank to skip zendesk)",
};

const REST: readonly Field[] = [
  {
    envVar: "MISSURA_INIT_ZENDESK_EMAIL",
    label: "Zendesk agent email",
  },
  {
    envVar: "MISSURA_INIT_ZENDESK_TOKEN",
    label: "Zendesk API token",
  },
];

/**
 * A subdomain, not a URL and not a host: `acme`, from which exactly one origin
 * follows. Taking a URL here would let a typo aim a real credential at a host
 * nobody vetted, and there is no reading of `acme.evil.test` that is safe.
 */
function originFor(subdomain: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(subdomain)) {
    throw new Error(
      `${SUBDOMAIN.envVar} must be the bare subdomain — "acme", not a URL or a host`,
    );
  }
  return `https://${subdomain.toLowerCase()}.zendesk.com`;
}

const FIELDS: readonly Field[] = [SUBDOMAIN, ...REST];

/**
 * The three answers, from the environment where it has them and from a real
 * terminal otherwise. A blank subdomain on a terminal ends the questioning:
 * there is no point asking for a credential to go with an origin nobody gave.
 */
async function collect(io: CliIo): Promise<string[]> {
  const values: string[] = [];
  for (const [index, field] of FIELDS.entries()) {
    const fromEnv = io.env[field.envVar];
    if (fromEnv !== undefined) {
      values.push(fromEnv.trim());
      continue;
    }
    if (!io.isTTY || (index > 0 && values[0] === "")) {
      values.push("");
      continue;
    }
    values.push((await io.prompt(`${field.label}: `)).trim());
  }
  return values;
}

/**
 * Zendesk API token auth (developer.zendesk.com, Security and Auth): the
 * username is the agent's email with a literal `/token` suffix, the password is
 * the API token, and the pair is HTTP Basic.
 */
function basic(email: string, token: string): string {
  const pair = Buffer.from(`${email}/token:${token}`, "utf8");
  return `Basic ${pair.toString("base64")}`;
}

/** `undefined` means "no zendesk connection", which is a legitimate answer. */
export async function readZendesk(
  io: CliIo,
): Promise<ZendeskConnection | undefined> {
  const values = await collect(io);
  if (values.every((value) => value === "")) return undefined;
  const missing = FIELDS.filter((_, i) => values[i] === "").map(
    (field) => field.envVar,
  );
  if (missing.length > 0) {
    throw new Error(
      `zendesk is half configured — missing ${missing.join(", ")}. Give all three, or none of them for a proxy that serves no zendesk.`,
    );
  }
  const [subdomain, email, token] = values as [string, string, string];
  return {
    authorization: basic(email, token),
    upstreamBase: originFor(subdomain),
  };
}
