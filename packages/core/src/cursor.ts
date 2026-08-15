import { randomUUID } from "node:crypto";

/**
 * Missura-owned pagination cursors (SPEC §22).
 *
 * A vendor cursor is a vendor POSITION. Handing one back after a REFILL walk
 * tells the agent how far we walked, and the walk length is a measure of how
 * many objects were hidden from it: the common Relay `arrayconnection:N`
 * spelling is plain base64, so `position_walked − page_size` = objects hidden.
 * Everything else about a walked answer is already indistinguishable from an
 * unwalked one; the cursor was the last field that was not.
 *
 * So the agent never sees a vendor cursor. It gets an opaque HANDLE and we keep
 * the position.
 *
 * A store rather than an encoding, and that is the whole design decision: an
 * encoded cursor — signed, encrypted, anything — has a LENGTH that varies with
 * the position it encodes, so `arrayconnection:5` and `arrayconnection:4711`
 * stay distinguishable through the envelope unless the plaintext is padded to a
 * fixed width. A random 128-bit handle is the same size for every position and
 * carries no function of it at all, so there is nothing left to pad and no
 * cryptographic construction to get subtly wrong.
 *
 * A handle is bound to the mission that received it. That closes a second
 * deferred consequence for free: a cursor stored under one mission and replayed
 * under a later one used to resume from a vendor position that mission never
 * walked, silently skipping or repeating objects. It now fails closed.
 *
 * The store is in memory and bounded, so it is lost on restart — an agent
 * paginating across a proxy restart is refused rather than served from a
 * position we can no longer vouch for. Missions are capped at 60 minutes, which
 * is what makes both the bound and the TTL safe to state.
 */

/** Handles one proxy keeps at once. Oldest go first — see `issue`. */
export const MAX_CURSORS = 10_000;

/** A handle outlives the longest mission a proxy will mint, and no more. */
export const CURSOR_TTL_MS = 60 * 60 * 1000;

export interface CursorStore {
  /** An opaque handle standing for `vendorCursor`, usable only by `missionId`. */
  issue(missionId: string, vendorCursor: string): string;
  /**
   * The vendor cursor behind `handle`, or `undefined` — never issued, expired,
   * evicted, or issued to a different mission. Callers must read `undefined` as
   * DENY: forwarding a cursor we cannot vouch for would resume the agent at a
   * vendor position nothing authorized.
   */
  resolve(missionId: string, handle: string): string | undefined;
}

interface Entry {
  missionId: string;
  vendorCursor: string;
  issuedAt: number;
}

export interface CursorStoreOptions {
  now?: () => number;
  max?: number;
  ttlMs?: number;
}

export function createCursorStore(
  options: CursorStoreOptions = {},
): CursorStore {
  const clock = options.now ?? Date.now;
  const max = options.max ?? MAX_CURSORS;
  const ttlMs = options.ttlMs ?? CURSOR_TTL_MS;
  // Insertion-ordered, which is what makes eviction "oldest first" without a
  // second structure: a Map iterates in the order keys were added.
  const entries = new Map<string, Entry>();

  return {
    issue(missionId: string, vendorCursor: string): string {
      const handle = randomUUID();
      entries.set(handle, { missionId, vendorCursor, issuedAt: clock() });
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return handle;
    },
    resolve(missionId: string, handle: string): string | undefined {
      const found = entries.get(handle);
      if (found === undefined) return undefined;
      if (clock() - found.issuedAt > ttlMs) {
        entries.delete(handle);
        return undefined;
      }
      // A handle is the mission's, not the agent process's: replaying one under
      // a different mission would resume a walk that mission never made.
      return found.missionId === missionId ? found.vendorCursor : undefined;
    },
  };
}
