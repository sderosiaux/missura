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

async function ask(io: CliIo, field: Field): Promise<string> {
  const fromEnv = io.env[field.envVar];
  if (fromEnv !== undefined) return fromEnv.trim();
  if (!io.isTTY) return "";
  return (await io.prompt(`${field.label}: `)).trim();
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
  const subdomain = await ask(io, SUBDOMAIN);
  const rest: string[] = [];
  for (const field of REST) rest.push(await ask(io, field));
  const given = [subdomain, ...rest].filter((value) => value.length > 0);
  if (given.length === 0) return undefined;
  if (given.length < 3) {
    const missing = [SUBDOMAIN, ...REST]
      .filter((_, i) => [subdomain, ...rest][i] === "")
      .map((field) => field.envVar);
    throw new Error(
      `zendesk is half configured — missing ${missing.join(", ")}. Give all three or none.`,
    );
  }
  const [email, token] = rest as [string, string];
  return {
    authorization: basic(email, token),
    upstreamBase: originFor(subdomain),
  };
}
