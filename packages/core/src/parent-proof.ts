/**
 * PARENT PROOF: how a child object whose own response names no owner is still
 * allowed under a mission (SPEC §4.4.2, the second hop).
 *
 * The response FILTER answers one question — "does this object name an owner
 * the mission covers?" — and a whole family of vendor objects cannot answer it.
 * A Zendesk ticket comment publishes no organization AND no ticket: its only
 * link to a scopable object is the ticket id in the REQUEST PATH. A Linear
 * comment and an attachment are the same shape. For those, the owner is a
 * property of the PARENT, so the mission has to be proven against the parent
 * before the child is served.
 *
 * So a connector may attach a `ParentProof` to an ALLOW: "fetch this, read the
 * owner there, and only then let my request run". The proxy does the fetching,
 * through the one forward path it already has, and remembers the verdict for
 * the mission that bought it.
 *
 * The requirement is DATA, never a callback. A connector that could hand the
 * proxy a closure would be putting vendor knowledge back into the pipeline —
 * and a description can be logged, compared and tested, which a function
 * cannot.
 */

/** The probe request, in the same three fields every request is described by. */
export interface ParentProofProbe {
  method: string;
  /** Path plus query string, in the connector's own canonical spelling. */
  path: string;
  body: string;
}

/**
 * One parent to prove before the child request may run.
 *
 * It names three things and no more. In particular it does NOT name the
 * acceptable owners: those are the mission's, the proxy already holds them
 * beside this requirement (`NarrowResult.missionOwnerIds`), and a connector
 * that could restate them here could also widen them.
 */
export interface ParentProof {
  /**
   * Stable identity of the object being proven, in the connector's own terms
   * (`"ticket:35436"`). It is the memo key, so it must name the PARENT and
   * nothing about the child: two different comment pages under one ticket are
   * one proof. It is scoped by the mission and by the connection at the store,
   * never by the connector.
   */
  key: string;
  /** The request that fetches the parent. It goes out through `forward`. */
  probe: ParentProofProbe;
  /**
   * Where the owner id sits in the probe's parsed response, from the body root:
   * `["ticket","organization_id"]`. Read with the same resolver a `FilterRule`
   * uses, so an owner that is missing, `null`, or of the wrong type resolves to
   * nothing — which is FOREIGN, never a pass.
   */
  ownerPath: readonly string[];
}

/** Proofs one proxy keeps at once, across every mission. Oldest go first. */
export const MAX_PARENT_PROOFS = 10_000;

/**
 * A proof outlives no mission: `MAX_TTL_SECONDS` is the hard cap on a minted
 * mission, so an entry at that age belongs to a mission that can no longer
 * present a token. Pinned against the mint in `parent-proof.test.ts`.
 */
export const PARENT_PROOF_TTL_MS = 60 * 60 * 1000;

/**
 * What the proxy remembers between requests of ONE mission.
 *
 * There is no `forget`, and that is deliberate: revocation is consulted on the
 * hot path before anything else (`pipeline.ts`), so a revoked mission never
 * reaches the stage that reads this store. An entry it left behind is
 * unreachable rather than merely stale — its jti is random per mission, so no
 * later mission can address it, and the TTL collects it.
 */
export interface ParentProofStore {
  /** Has `key` already been proven for THIS mission? */
  isProven(jti: string, key: string): boolean;
  /** Record that `key` is proven for THIS mission. */
  record(jti: string, key: string): void;
}

export interface ParentProofStoreOptions {
  now?: () => number;
  max?: number;
  ttlMs?: number;
}

/**
 * Composed, never concatenated: a connector chooses the key, so `jti + ":" +
 * key` would let a key spelled `b:c` under mission `a` answer for key `c` under
 * a mission called `a:b`. JSON has one spelling per pair.
 */
function entryKey(jti: string, key: string): string {
  return JSON.stringify([jti, key]);
}

interface Entry {
  provenAt: number;
}

/**
 * In memory and bounded, exactly like the cursor store: it is lost on restart,
 * which costs one extra probe and never a wrong ALLOW.
 */
export function createParentProofStore(
  options: ParentProofStoreOptions = {},
): ParentProofStore {
  const clock = options.now ?? Date.now;
  const max = options.max ?? MAX_PARENT_PROOFS;
  const ttlMs = options.ttlMs ?? PARENT_PROOF_TTL_MS;
  // Insertion-ordered, which is what makes eviction "oldest first" without a
  // second structure: a Map iterates in the order keys were added.
  const entries = new Map<string, Entry>();

  return {
    isProven(jti: string, key: string): boolean {
      const id = entryKey(jti, key);
      const found = entries.get(id);
      if (found === undefined) return false;
      if (clock() - found.provenAt > ttlMs) {
        entries.delete(id);
        return false;
      }
      return true;
    },
    record(jti: string, key: string): void {
      const id = entryKey(jti, key);
      // Re-recording keeps the ORIGINAL age: a proof must not be renewable by
      // asking again, or a long-lived agent would hold one past its mission.
      const existing = entries.get(id);
      entries.set(id, existing ?? { provenAt: clock() });
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
  };
}
