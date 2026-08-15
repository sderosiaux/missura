/**
 * What may be written down.
 *
 * The report and the coverage manifest are COMMITTED. They are produced by a
 * run against a real support tenant, a real Linear workspace and a real
 * repository, so the rule is not "avoid obvious secrets" — it is that an
 * identifier belonging to the human's customers does not leave the process.
 *
 * Two different mechanisms carry that rule, and it is worth being clear about
 * which does what:
 *   - response BODIES never reach a file at all. Nothing in the report is a
 *     vendor payload; the shape comparison produces PATHS and counts, and those
 *     are what gets written;
 *   - request TARGETS do reach a file, because "what missura forwarded" is the
 *     evidence for the narrowing claim. Those go through here first.
 *
 * The substitution is deliberately blunt. A digit run of four or more is an id
 * (a Zendesk organization, a ticket number, a user); shorter runs are page
 * sizes and version numbers, which say nothing about anyone. A UUID is a Linear
 * identifier. Being too aggressive costs a reader nothing — `organization:{id}`
 * still shows that a qualifier was forced in, which is the whole point.
 */

const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Four digits or more: an object id. Three or fewer: a page size, a version. */
const LONG_NUMBER = /\d{4,}/g;
/** A percent-encoded UUID or id survives the two above; catch the encoding too. */
const ENCODED_UUID = /(?:[0-9a-f]{8})(?:%2D|-)(?:[0-9a-f]{4})/gi;

export function redact(text: string): string {
  return text
    .replace(UUID, "{uuid}")
    .replace(ENCODED_UUID, "{uuid}")
    .replace(LONG_NUMBER, "{id}");
}

/** Redacts a list, dropping nothing: a removed entry would hide a finding. */
export function redactAll(items: readonly string[]): string[] {
  return items.map(redact);
}
