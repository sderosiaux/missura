/**
 * THE ENTITY KEY — `type:name`, and the one spelling everything speaks.
 *
 * A mission scope, the graph file, the CLI flag and the operator request body
 * all carry the SAME string. There is no place left that builds a key by
 * concatenating a prefix onto a bare name, which is what made every entity a
 * customer: `customer:adeo`, `employee:stephane` and `project:atlas` are the
 * same kind of thing, and only the operator decides which.
 *
 * THE SHAPE IS ENFORCED, not merely conventional. `adeo` is refused rather than
 * read as "some entity called adeo": the pre-M5 CLI spelled that exact string
 * for `customer:adeo`, so accepting it would turn a stale habit into a lookup
 * that quietly matches nothing — a mission minted narrow, or refused with an
 * "unknown entity" that names a key the operator never wrote. The colon costs a
 * migration once; guessing costs a wrong answer every time.
 *
 * The split is on the FIRST colon only. The type is ours to constrain; the name
 * is the operator's, and a vendor-shaped name that carries a colon of its own
 * stays legible.
 */

/** Refuses anything a lookup could not match, and returns the key unchanged. */
export function assertEntityKey(key: string): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("entity key must be a non-empty string");
  }
  if (/\s/.test(key)) {
    throw new Error(`entity key "${key}" must not contain whitespace`);
  }
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) {
    throw new Error(
      `entity key "${key}" must be "type:name" — e.g. customer:adeo, employee:stephane, project:atlas`,
    );
  }
  return key;
}
