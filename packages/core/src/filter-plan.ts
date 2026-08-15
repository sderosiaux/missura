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
 * finds there it reads `ownerPath` and compares it to `expectedOwnerIds`. An
 * object whose owner does not resolve to one of them is FOREIGN — missing,
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
  /**
   * The mission's resolved owner ids. An object is ours when its resolved
   * owner matches ANY of them.
   *
   * A set, not a single id, because a mission holds a set of entities: one
   * GitHub mission covers several repos, so a search result is ours if its
   * repository is any of them. Emitting one rule per owner on the same path
   * cannot express that — each rule would drop what the others keep. A
   * connector with a single resolved owner emits a one-element array, which
   * stays the ordinary case.
   *
   * An EMPTY set owns nothing: every object at `path` is foreign. That is the
   * fail-closed reading of "the mission resolves to no entity here", and it is
   * deliberately not an error the proxy has to notice.
   */
  expectedOwnerIds: readonly string[];
  /**
   * How a resolved owner is compared to `expectedOwnerIds`.
   *
   *   - `exact`: byte-for-byte. Opaque vendor ids (a Linear UUID) are exact,
   *     and exactness is the default a connector should have to argue against.
   *   - `ascii-case-insensitive`: A–Z folded to a–z, nothing else. GitHub
   *     names an `owner/repo` case-insensitively but answers with the casing
   *     it stored, so a mission typed `Acme-Corp/Product` must still match a
   *     `.../acme-corp/product` in the body.
   *
   * The folding is ASCII-only on purpose: `String.toLowerCase()` maps `K`
   * (U+212A KELVIN SIGN) to `k`, so a foreign `acme/Kafka` would pass as the
   * mission's `acme/kafka`. A case rule that widens the set of matching
   * identifiers beyond the vendor's own rule is a hole, not a convenience.
   */
  ownerMatch: "exact" | "ascii-case-insensitive";
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
 * Where the paginated collection is, and how to ask the vendor for its next
 * page — the minimum the proxy needs to REFILL a page filtering made short,
 * without learning the vendor's query language.
 *
 * A connector emits this only when it can guarantee the re-issued request means
 * "the same query, one page further": the document it narrowed must bind the
 * variable at `cursorPath` to the collection's `after:` argument. At most one
 * per plan — two collections in one document cannot share a single cursor, and
 * a connector that sees two must emit none rather than refill the wrong one.
 */
export interface PaginationRule {
  /** Path from the body root to the connection object: `["data","issues"]`. */
  path: readonly string[];
  /** Key of the node list inside it: `"nodes"`. */
  nodes: string;
  /** Path to the page info object, relative to the connection: `["pageInfo"]`. */
  pageInfo: readonly string[];
  /**
   * How many objects the agent asked for. The proxy walks until it has this
   * many authorized ones, and never returns more — an answer longer than the
   * page the agent requested would itself say that pages were walked.
   */
  requested: number;
  /**
   * Path INSIDE the JSON request body where the next cursor is written:
   * `["variables","after"]`. Every parent must already exist — the proxy
   * writes a value, it never invents a request shape.
   */
  cursorPath: readonly string[];
}

/**
 * Everything the proxy must do to one response. A plan with no rules and
 * nothing to strip is not an error — it means the answer needs no repair, and
 * the body is returned byte for byte.
 */
export interface FilterPlan {
  rules: readonly FilterRule[];
  /**
   * Absent ⇒ the proxy never issues a second upstream call for this request.
   * A connector that cannot describe its pagination gets short pages, which is
   * the safe half of the tradeoff.
   */
  pagination?: PaginationRule;
  /**
   * Absolute paths (body root first) to fields that must be removed on the way
   * out, whatever the ownership verdict: everything else NARROW widened, and
   * anything the connector refuses to expose. `"*"` segments are supported, so
   * one entry can address a field inside every element of a list. A path whose
   * leaf is absent is a no-op, never an error.
   */
  strip: readonly (readonly string[])[];
}
