import type { Provider } from "@missura/core";
import { isRecord } from "./filter-json";
import type { ResponseShape } from "./transport";

/**
 * The REDUCED marker (§7quinquies.4): a view the proxy cut down is flagged,
 * never measured.
 *
 * When the FILTER removed objects or the REFILL walked pages, the agent is told
 * the response was reduced by policy — so it can say "there may be issues I
 * cannot see" instead of "there are no issues". It is told nothing else: not
 * how many objects, not how many pages, not the vendor's total. The proxy
 * knows all three and none of them is serialized; the marker is a boolean and
 * that is the whole of it.
 *
 * ONE boolean for the WHOLE response, deliberately. A marker per path would
 * say "something was hidden HERE", which turns the shape of the answer into a
 * map of where the foreign objects sat.
 *
 * Absence is meaningful: a response with nothing removed and no walk carries
 * no marker, so `reduced: false` is never written.
 *
 * Where it rides depends on the vendor's own envelope, because the marker has
 * to survive the SDK: GraphQL clients keep `extensions` and ignore keys they
 * do not know, so Linear gets `extensions.missura.reduced`; REST clients keep
 * headers, so GitHub and Zendesk get `missura-reduced: true`.
 */
export const REDUCED_HEADER = "missura-reduced";

const EXTENSIONS = "extensions";

/** The GraphQL body with the marker merged into `extensions`, or `undefined`. */
function withExtension(body: string | Uint8Array): string | undefined {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const existing = parsed[EXTENSIONS];
  const extensions = isRecord(existing) ? existing : {};
  const missura = isRecord(extensions.missura) ? extensions.missura : {};
  return JSON.stringify({
    ...parsed,
    [EXTENSIONS]: { ...extensions, missura: { ...missura, reduced: true } },
  });
}

export function markReduced(
  provider: Provider,
  res: ResponseShape,
  reduced: boolean,
): ResponseShape {
  if (!reduced) return res;
  if (provider === "linear") {
    const body = withExtension(res.body);
    // A reduced GraphQL body is one the filter rebuilt, so it parses; this
    // fallback exists so the marker cannot be lost if that ever stops holding.
    if (body !== undefined) return { ...res, body };
  }
  return { ...res, headers: { ...res.headers, [REDUCED_HEADER]: "true" } };
}
