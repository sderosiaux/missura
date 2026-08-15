/**
 * The contract between a connector's NARROW and the proxy's response FILTER.
 *
 * A connector understands its vendor's query language and schema; the proxy
 * understands none of it. So the connector describes, in plain JSON paths,
 * WHERE the owned objects will land in the response and HOW to prove who owns
 * them — and the proxy applies that description to the parsed body. This is
 * the seam that lets enforcement move from "refuse the request" to "let it run
 * and filter the answer" (SPEC §4.4.2) without teaching the proxy GraphQL.
 *
 * It is a published interface: every connector produces plans against it and
 * the proxy is the single consumer. Changing a field here changes every
 * connector.
 */

/**
 * One ownership check, at one place in the response.
 *
 * The proxy resolves `path` against the parsed body, and for every object it
 * finds there it reads `ownerPath` and compares it to `expectedOwnerId`. An
 * object whose owner does not resolve to exactly that id is FOREIGN — missing,
 * `null`, or of the wrong type all count as foreign, never as a pass.
 */
export interface FilterRule {
  /**
   * Response path to the object(s) this rule guards, from the body root:
   * `["data","issue"]` for a single object, `["data","issues","nodes","*"]` for
   * every element of a list. A `"*"` segment means "every element of the array
   * at this position" and may appear more than once (nested lists). A trailing
   * `"*"` makes this a LIST rule: foreign elements are dropped. Anything else
   * is a SINGLE-OBJECT rule: a foreign object is nulled or the response fails
   * closed, per `nullable`.
   */
  path: readonly string[];
  /**
   * The vendor type of the object at `path` (`"Issue"`, `"Comment"`, …). The
   * proxy never branches on it — it exists so an audit record, a test failure
   * or a connector bug names the type the connector believed it was guarding.
   */
  type: string;
  /**
   * Path from that object to its owning entity id, relative to the object:
   * `["customer","id"]` on an `Issue`, `["id"]` on a `Customer` itself. Every
   * segment must resolve through plain objects; the leaf must be a non-empty
   * string.
   */
  ownerPath: readonly string[];
  /** The mission's resolved owner id. Only an exact match keeps the object. */
  expectedOwnerId: string;
  /**
   * Field names, directly on the object at `path`, that WE added to the
   * request so the ownership check would be possible — and that must therefore
   * not reach the agent. Only these: a discriminator the agent asked for
   * itself is the agent's and survives. A field we widened *inside* a nested
   * object the agent did ask for is not "at that path": express it as an
   * absolute entry in `FilterPlan.strip` (or as another rule's `injected`).
   */
  injected: readonly string[];
  /**
   * May a foreign single object be replaced by `null`? Only true when the
   * vendor schema declares that field nullable — nulling a non-nullable field
   * hands the SDK a body its own types reject. When it is false, a foreign
   * object is a request the connector's walk should have refused before the
   * call, and the proxy fails closed on the whole response.
   *
   * Ignored for LIST rules: dropping an element from a list never breaks the
   * vendor schema.
   */
  nullable: boolean;
}

/**
 * Everything the proxy must do to one response. A plan with no rules and
 * nothing to strip is not an error — it means the answer needs no repair, and
 * the body is returned byte for byte.
 */
export interface FilterPlan {
  rules: readonly FilterRule[];
  /**
   * Absolute paths (body root first) to fields that must be removed on the way
   * out, whatever the ownership verdict: everything else NARROW widened, and
   * anything the connector refuses to expose. `"*"` segments are supported, so
   * one entry can address a field inside every element of a list. A path whose
   * leaf is absent is a no-op, never an error.
   */
  strip: readonly (readonly string[])[];
}
