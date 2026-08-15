import { ZENDESK_NOT_FOUND_BODY } from "@missura/proxy";
import type { Exchange } from "./classify";
import { assumption, type Assumption, type ZendeskCredential } from "./harness";
import { checkErrorEnvelope, mediaType } from "./vendor-shapes";
import {
  bodyKeys,
  TINY_PAGE,
  zendeskCall,
  zendeskUnauthenticatedCall,
} from "./zendesk-api";

/**
 * HALF A, Zendesk — what a refusal actually looks like.
 *
 * The third fact the connector author could not establish from documentation.
 * It is not decoration: missura answers its own refusals in the vendor's
 * envelope so an SDK can parse them (`vendor-shapes.ts` encodes which shapes
 * count), and `packages/proxy/src/narrow.ts` pins Zendesk's not-found BYTE FOR
 * BYTE so an object outside the mission and one that never existed are
 * indistinguishable. A vendor that changed either of those turns a careful
 * refusal into one no client can read, or into an enumeration oracle.
 *
 * Every probe here is a GET. The 401 is the one that cannot be produced with a
 * working credential, so it is produced with a literal non-credential.
 */

const PROXY_NARROW_FILE = "packages/proxy/src/narrow.ts";
const VENDOR_SHAPES_FILE = "examples/compat/vendor-shapes.ts";

/** An id no Zendesk account issues, so the answer is absence and not a record. */
const ABSENT_TICKET_ID = "999999999999";

/** Status, media type and the KEY SET — the shape of a refusal, not its text. */
function shapeOf(exchange: Exchange): string {
  const keys = bodyKeys(exchange.body);
  const type = mediaType(exchange.headers["content-type"]) ?? "(none)";
  return `status ${String(exchange.status)}, content-type ${type}, top-level keys {${keys.join(", ")}}`;
}

function envelopeNote(exchange: Exchange): string {
  const verdict = checkErrorEnvelope("zendesk", exchange.body);
  return verdict.ok
    ? "the body wears one of Zendesk's two documented error envelopes"
    : (verdict.reason ?? "the body is not a Zendesk error envelope");
}

/**
 * One status, probed. A probe that produced a DIFFERENT status is
 * UNVERIFIABLE, never BROKEN: this tenant's configuration decides what is
 * forbidden to an admin token, and "I could not make Zendesk answer 403" is a
 * fact about the run, not about the vendor.
 */
function errorAssumption(
  id: string,
  status: number,
  probe: string,
  exchange: Exchange,
): Assumption {
  const base = {
    id,
    vendor: "zendesk" as const,
    claim: `a Zendesk ${String(status)} carries one of the two documented error envelopes — \`{error, description}\` or \`{error: {title, message}}\``,
    encodedIn: VENDOR_SHAPES_FILE,
  };
  if (exchange.status !== status) {
    return assumption(
      base,
      "UNVERIFIABLE",
      `${probe} answered ${String(exchange.status)}, not ${String(status)} — this run could not provoke that refusal (observed: ${shapeOf(exchange)})`,
    );
  }
  const verdict = checkErrorEnvelope("zendesk", exchange.body);
  return assumption(
    base,
    verdict.ok ? "HOLDS" : "BROKEN",
    `${probe} → ${shapeOf(exchange)}; ${envelopeNote(exchange)}`,
  );
}

/**
 * The 404 the proxy IMITATES, byte for byte.
 *
 * This one is stricter than an envelope check on purpose. A refusal that is
 * merely envelope-shaped but not byte-identical is distinguishable from the
 * vendor's own absence, and a client that can tell "you may not see this" from
 * "this does not exist" can enumerate what it may not see.
 */
function notFoundBytes(exchange: Exchange): Assumption {
  const base = {
    id: "zendesk.error.404-bytes",
    vendor: "zendesk" as const,
    claim: `Zendesk's own not-found body is exactly ${ZENDESK_NOT_FOUND_BODY} — the bytes missura answers with when a filter proves an object foreign`,
    encodedIn: PROXY_NARROW_FILE,
  };
  if (exchange.status !== 404) {
    return assumption(
      base,
      "UNVERIFIABLE",
      `the absent-ticket probe answered ${String(exchange.status)}, not 404 (${shapeOf(exchange)})`,
    );
  }
  const live = exchange.body.trim();
  if (live === ZENDESK_NOT_FOUND_BODY) {
    return assumption(base, "HOLDS", "the live 404 body matches the pinned bytes exactly");
  }
  return assumption(
    base,
    "BROKEN",
    `the live 404 body is \`${live.slice(0, 120)}\`, and missura answers \`${ZENDESK_NOT_FOUND_BODY}\` — an out-of-scope object is now distinguishable from one that never existed`,
  );
}

/**
 * The four refusals, in the order they cost the least. The 401 runs first
 * because it is the only one that needs a different credential, and running it
 * once keeps this suite from looking like a credential-stuffing client.
 */
export async function zendeskErrorAssumptions(
  credential: ZendeskCredential,
  organizationId: string,
): Promise<Assumption[]> {
  const unauthorized = await zendeskUnauthenticatedCall(
    credential,
    "zendesk · probe 401 with a deliberately invalid credential",
    `/api/v2/organizations/${organizationId}.json`,
  );
  const forbidden = await zendeskCall(
    credential,
    "zendesk · probe 403 on an endpoint an admin token may still not read",
    `/api/v2/audit_logs.json?per_page=${String(TINY_PAGE)}`,
  );
  const absent = await zendeskCall(
    credential,
    "zendesk · probe 404 on a ticket id no account issues",
    `/api/v2/tickets/${ABSENT_TICKET_ID}.json`,
  );
  const malformed = await zendeskCall(
    credential,
    "zendesk · probe 422 with an empty search query",
    "/api/v2/search.json?query=",
  );

  return [
    errorAssumption(
      "zendesk.error.401",
      401,
      "a GET with an invalid API token",
      unauthorized,
    ),
    errorAssumption(
      "zendesk.error.403",
      403,
      "GET /api/v2/audit_logs",
      forbidden,
    ),
    errorAssumption(
      "zendesk.error.404",
      404,
      "GET /api/v2/tickets/{absent}",
      absent,
    ),
    errorAssumption(
      "zendesk.error.422",
      422,
      "GET /api/v2/search with an empty query",
      malformed,
    ),
    notFoundBytes(absent),
  ];
}
