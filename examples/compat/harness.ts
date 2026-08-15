import type { Vendor } from "./vendor-shapes";

/**
 * Gates, credentials and the two result shapes both halves report in.
 *
 * Unlike the M1–M3 proofs, this suite HOLDS the vendor credentials: half B
 * cannot compare a direct call against a proxied one without making the direct
 * call. So the rule those proofs enforce — no vendor credential in this
 * process — is inverted here, deliberately and out loud. Nothing in this
 * package proves credential isolation; `examples/m2-proof` does that.
 */

export type Verdict = "HOLDS" | "BROKEN" | "UNVERIFIABLE" | "SKIP";

/** One vendor fact a connector depends on, and what the vendor said about it. */
export interface Assumption {
  /** Stable id, so a manifest diff across runs is readable. */
  id: string;
  vendor: Vendor;
  /** The claim, as the connector makes it. */
  claim: string;
  verdict: Verdict;
  /** What the vendor actually answered. Never a restatement of the claim. */
  evidence: string;
  /** The file that encodes the assumption — what to open when it breaks. */
  encodedIn: string;
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * This suite talks to real vendors with real credentials. The opt-in is
 * explicit so a CI runner, a watcher or a stray `tsx run.ts` stops here instead
 * of hitting somebody's workspace.
 */
export function assertLive(): void {
  if (process.env.MISSURA_LIVE !== "1") {
    fail(
      "refusing to run: this is a live compatibility suite against real vendor APIs.\n" +
        "  MISSURA_LIVE=1 pnpm compat\n" +
        "It is strictly read-only (see http.ts, where that is asserted rather than promised),\n" +
        "but it does read from the workspaces whose credentials are in your environment.",
    );
  }
}

export interface LinearCredential {
  apiKey: string;
  /** The mission's customer, as a Linear `Customer.id` (a UUID). */
  customerId: string;
}

export interface GithubCredential {
  token: string;
  /** `owner/name`, the mission's repo. */
  repo: string;
}

export interface ZendeskCredential {
  subdomain: string;
  email: string;
  apiToken: string;
  /** Organization ids in scope; the first is the primary one. */
  organizationIds: string[];
}

export interface Credentials {
  linear?: LinearCredential;
  github?: GithubCredential;
  zendesk?: ZendeskCredential;
}

/** The reasons a connector's section is being skipped, per vendor. */
export type Skips = Partial<Record<Vendor, string>>;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * Zendesk's API-token authentication is HTTP Basic with the username
 * `{email}/token` and the token as the password — the shape `curl -u
 * "you@example.com/token:{token}"` documents. That is verified live in half A
 * (`zendesk.auth.email-token-basic`) rather than assumed here.
 */
export function zendeskAuthHeader(credential: ZendeskCredential): string {
  const pair = `${credential.email}/token:${credential.apiToken}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

export function zendeskBase(credential: ZendeskCredential): string {
  return `https://${credential.subdomain}.zendesk.com`;
}

/**
 * Credentials come from the environment, never from the vault: the suite must
 * run without `missura init`, and it needs the raw credential for the direct
 * half anyway. A missing one SKIPS that vendor's section with a message that
 * says exactly what to set — it never fails the run.
 */
export function credentials(): { credentials: Credentials; skips: Skips } {
  const out: Credentials = {};
  const skips: Skips = {};

  const linearKey = env("LINEAR_API_KEY");
  const linearCustomer = env("MISSURA_LINEAR_CUSTOMER_ID");
  if (linearKey === "") {
    skips.linear = "set LINEAR_API_KEY to include the Linear connector";
  } else if (linearCustomer === "") {
    skips.linear =
      "set MISSURA_LINEAR_CUSTOMER_ID to a Customer.id (UUID) of your workspace — a mission with no customer narrows nothing";
  } else {
    out.linear = { apiKey: linearKey, customerId: linearCustomer };
  }

  const githubToken = env("GITHUB_TOKEN");
  const githubRepo = env("MISSURA_GITHUB_REPO");
  if (githubToken === "") {
    skips.github = "set GITHUB_TOKEN to include the GitHub connector";
  } else if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(githubRepo)) {
    skips.github =
      "set MISSURA_GITHUB_REPO to owner/name — one repo you can read, ideally with issues and a nested file";
  } else {
    out.github = { token: githubToken, repo: githubRepo };
  }

  const subdomain = env("ZENDESK_SUBDOMAIN");
  const email = env("ZENDESK_EMAIL");
  const apiToken = env("ZENDESK_API_TOKEN");
  const missing = [
    ["ZENDESK_SUBDOMAIN", subdomain],
    ["ZENDESK_EMAIL", email],
    ["ZENDESK_API_TOKEN", apiToken],
  ]
    .filter(([, value]) => value === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    skips.zendesk = `set ${missing.join(", ")} to include the Zendesk connector`;
  } else {
    const ids = [
      env("ZENDESK_ORGANIZATION_ID"),
      env("ZENDESK_ORGANIZATION_ID_2"),
    ].filter((id) => /^[0-9]+$/.test(id));
    out.zendesk = {
      subdomain,
      email,
      apiToken,
      organizationIds: ids,
    };
  }

  return { credentials: out, skips };
}

const WIDTH = 13;

export function assumptionLine(assumption: Assumption): string {
  return `${assumption.verdict.padEnd(WIDTH)} ${assumption.id}\n${" ".repeat(WIDTH)} ${assumption.evidence}`;
}

/** Builds one assumption result, so no call site can forget the `encodedIn`. */
export function assumption(
  base: Omit<Assumption, "verdict" | "evidence">,
  verdict: Verdict,
  evidence: string,
): Assumption {
  return { ...base, verdict, evidence };
}

/**
 * Runs one assumption check, turning a thrown error into UNVERIFIABLE rather
 * than a crash: a network blip must not read as a broken vendor contract.
 */
export async function checked(
  base: Omit<Assumption, "verdict" | "evidence">,
  run: () => Promise<{ verdict: Verdict; evidence: string }>,
): Promise<Assumption> {
  try {
    const { verdict, evidence } = await run();
    return assumption(base, verdict, evidence);
  } catch (err) {
    return assumption(
      base,
      "UNVERIFIABLE",
      `the check itself failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
