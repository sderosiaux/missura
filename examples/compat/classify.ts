import { diffShapes, type ShapeDiff } from "./shape";
import {
  checkErrorEnvelope,
  inVocabulary,
  mediaType,
  type Vendor,
} from "./vendor-shapes";

/**
 * HALF B's verdict. Differences between the vendor's answer and ours are
 * EXPECTED — narrowing and filtering are the product — so this classifies
 * rather than fails, with exactly one failing category.
 *
 *   compatible              identical, byte-shape for byte-shape.
 *   compatible_with_rewrite the request reached the vendor narrowed; the
 *                           response shape is intact.
 *   compatible_with_filter  objects were removed or a count/position stripped;
 *                           the schema is intact.
 *   unsupported             we refuse it by design, and the refusal wears the
 *                           vendor's own envelope.
 *   unsafe                  a difference that breaks a typed SDK consumer.
 *
 * `unsafe` is the operational definition of the "same API" promise: a
 * non-nullable field gone or nulled, a status no client of that vendor has a
 * branch for, an error body its SDK cannot parse, a cataloged operation
 * refused, a refused operation served.
 */
export type Classification =
  | "compatible"
  | "compatible_with_rewrite"
  | "compatible_with_filter"
  | "unsupported"
  | "unsafe";

export interface OperationSpec {
  operation: string;
  vendor: Vendor;
  /** The call as an SDK consumer writes it, for the manifest. */
  request: string;
  /** What the connector narrows in the request — the claim; `upstream` is the evidence. */
  narrowed: string[];
  /** What the connector removes from the response, in prose, for the manifest. */
  filtered: string[];
  /** Non-empty ⇒ refused by design; the run expects `unsupported`. */
  refused: string[];
  /** Response paths the connector's FilterPlan declares it strips (`*` allowed). */
  strips: readonly string[];
  /** Response paths the connector is allowed to replace with `null`. */
  nullable?: readonly string[];
}

export interface Exchange {
  /** False when the suite deliberately did not make this call. */
  issued: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ClassifyInput {
  spec: OperationSpec;
  direct: Exchange;
  proxied: Exchange;
  /** What the proxy actually sent the vendor, as `METHOD path` — recorded, not claimed. */
  upstream: string | undefined;
  /** What the agent asked the proxy for, same spelling. */
  agentRequest: string;
}

export interface ClassifyResult {
  classification: Classification;
  /** Why it is not `compatible`, in the order the rules fired. */
  reasons: string[];
  /** Every difference that would break a typed consumer. Non-empty ⇒ unsafe. */
  unsafe: string[];
  /** Differences worth recording that break nothing. */
  notes: string[];
  objectsRemoved: number;
  /** The rewritten upstream request, when it differed from the agent's. */
  observedNarrowing?: string;
  diff?: ShapeDiff;
}

/** True when a response path is covered by a declared strip or nullable entry. */
function declared(path: string, entries: readonly string[]): boolean {
  return entries.some(
    (entry) => path === entry || path.startsWith(`${entry}.`),
  );
}

function isError(status: number): boolean {
  return status >= 400;
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Every error an SDK will meet has to be one it can parse. */
function envelopeFindings(input: ClassifyInput): string[] {
  const { proxied, spec } = input;
  if (!isError(proxied.status)) return [];
  const verdict = checkErrorEnvelope(spec.vendor, proxied.body);
  return verdict.ok || verdict.reason === undefined ? [] : [verdict.reason];
}

function statusFindings(input: ClassifyInput): string[] {
  const { direct, proxied, spec } = input;
  const out: string[] = [];
  if (!inVocabulary(spec.vendor, proxied.status)) {
    out.push(
      `status ${String(proxied.status)} is outside ${spec.vendor}'s own vocabulary — no generated client has a branch for it`,
    );
  }
  if (!direct.issued || direct.status === proxied.status) return out;
  if (!isError(direct.status) && isError(proxied.status)) {
    out.push(
      `the vendor answered ${String(direct.status)} and missura answered ${String(proxied.status)} — a client calling a CATALOGED operation gets a refusal the vendor would not have sent`,
    );
    return out;
  }
  if (isError(direct.status) && !isError(proxied.status)) {
    out.push(
      `the vendor refused with ${String(direct.status)} and missura served ${String(proxied.status)}`,
    );
    return out;
  }
  out.push(
    `status differs: vendor ${String(direct.status)}, missura ${String(proxied.status)}`,
  );
  return out;
}

function headerFindings(input: ClassifyInput): {
  unsafe: string[];
  notes: string[];
} {
  const { direct, proxied } = input;
  if (!direct.issued) return { unsafe: [], notes: [] };
  const before = mediaType(direct.headers["content-type"]);
  const after = mediaType(proxied.headers["content-type"]);
  const unsafe: string[] = [];
  if (before !== undefined && after !== before) {
    unsafe.push(
      `content-type changed from \`${before}\` to \`${after ?? "(absent)"}\` — an SDK branches on it before it reads a byte`,
    );
  }
  const dropped = Object.keys(direct.headers)
    .filter((name) => name !== "content-type" && !(name in proxied.headers))
    .sort();
  return {
    unsafe,
    // Headers are not part of any generated type, so a header missura chooses
    // not to relay is recorded and never failed.
    notes:
      dropped.length === 0
        ? []
        : [`vendor headers not relayed: ${dropped.join(", ")}`],
  };
}

function shapeFindings(
  input: ClassifyInput,
  diff: ShapeDiff,
): { unsafe: string[]; filtered: string[] } {
  const { spec } = input;
  const unsafe: string[] = [];
  const filtered: string[] = [];
  for (const entry of diff.missing) {
    if (declared(entry.path, spec.strips)) {
      filtered.push(`stripped \`${entry.path}\``);
      continue;
    }
    unsafe.push(
      `field \`${entry.path}\` (${entry.kinds.join("|")}) is gone from the proxied answer and no connector rule declares removing it`,
    );
  }
  for (const entry of diff.retyped) {
    if (entry.proxied === "null" && declared(entry.path, spec.nullable ?? [])) {
      filtered.push(`nulled \`${entry.path}\``);
      continue;
    }
    unsafe.push(
      `field \`${entry.path}\` came back \`${entry.proxied}\` where the vendor sent ${entry.direct.join("|")} — a typed client rejects that body`,
    );
  }
  for (const entry of diff.grew) {
    unsafe.push(
      `list \`${entry.path}\` came back LONGER than the vendor's own answer (${String(entry.direct)} → ${String(entry.proxied)})`,
    );
  }
  for (const entry of diff.added) {
    // An added field cannot break a parse; a typed client ignores what it does
    // not declare. Recorded as filtering's counterpart, never as a failure.
    filtered.push(`added \`${entry.path}\``);
  }
  return { unsafe, filtered };
}

/** The refusal path: an operation the connector says it will never serve. */
function classifyRefused(input: ClassifyInput): ClassifyResult {
  const { proxied, spec } = input;
  const unsafe = envelopeFindings(input);
  if (!isError(proxied.status)) {
    unsafe.push(
      `an operation the connector refuses by name was SERVED (status ${String(proxied.status)})`,
    );
  }
  return {
    classification: unsafe.length > 0 ? "unsafe" : "unsupported",
    reasons: spec.refused,
    unsafe,
    notes: [],
    objectsRemoved: 0,
  };
}

export function classify(input: ClassifyInput): ClassifyResult {
  const { spec, direct, proxied, upstream, agentRequest } = input;
  if (spec.refused.length > 0) return classifyRefused(input);

  const unsafe = [...envelopeFindings(input), ...statusFindings(input)];
  const headers = headerFindings(input);
  unsafe.push(...headers.unsafe);

  const reasons: string[] = [];
  const rewritten = upstream !== undefined && upstream !== agentRequest;
  if (rewritten) reasons.push(`request rewritten to: ${upstream}`);

  let objectsRemoved = 0;
  let diff: ShapeDiff | undefined;
  let filtered: string[] = [];
  if (
    direct.issued &&
    !isError(direct.status) &&
    !isError(proxied.status) &&
    direct.status === proxied.status
  ) {
    diff = diffShapes(parseBody(direct.body), parseBody(proxied.body));
    objectsRemoved = diff.shrunk.reduce(
      (total, change) => total + (change.direct - change.proxied),
      0,
    );
    const found = shapeFindings(input, diff);
    unsafe.push(...found.unsafe);
    filtered = found.filtered;
    if (objectsRemoved > 0) {
      filtered.unshift(`${String(objectsRemoved)} object(s) removed`);
    }
  }
  reasons.push(...filtered);

  const classification: Classification =
    unsafe.length > 0
      ? "unsafe"
      : filtered.length > 0
        ? "compatible_with_filter"
        : rewritten
          ? "compatible_with_rewrite"
          : "compatible";

  return {
    classification,
    reasons,
    unsafe,
    notes: headers.notes,
    objectsRemoved,
    ...(rewritten ? { observedNarrowing: upstream } : {}),
    ...(diff === undefined ? {} : { diff }),
  };
}
