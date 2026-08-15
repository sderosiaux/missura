/** W3C `traceparent`: `<version>-<trace-id>-<parent-id>-<flags>`. */
const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

const INVALID_TRACE_ID = "0".repeat(32);

/**
 * Reads the trace-id out of an inbound `traceparent`. The header itself is
 * forwarded to the vendor untouched — this only decides what lands in the
 * decision event, and a malformed value lands as nothing rather than as an
 * agent-controlled string in the audit log.
 */
export function traceIdOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  const traceId = match?.[1];
  if (traceId === undefined || traceId === INVALID_TRACE_ID) return undefined;
  return traceId;
}
