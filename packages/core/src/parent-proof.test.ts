import { describe, expect, it } from "vitest";
import {
  createParentProofStore,
  PARENT_PROOF_TTL_MS,
  type ParentProof,
} from "./parent-proof";
import { MAX_TTL_SECONDS } from "./token";

const JTI = "jti-1";

describe("parent proof — the requirement a connector publishes", () => {
  /**
   * The contract is minimal and SERIALIZABLE on purpose: a connector hands the
   * proxy a description, never a closure. Anything the proxy would have to call
   * back into the connector for would put vendor knowledge back in the pipeline.
   */
  it("names the key, the probe and the owner path, and nothing else", () => {
    const proof: ParentProof = {
      key: "ticket:35436",
      probe: { method: "GET", path: "/api/v2/tickets/35436", body: "" },
      ownerPath: ["ticket", "organization_id"],
    };

    expect(Object.keys(proof).sort()).toEqual(["key", "ownerPath", "probe"]);
    expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
  });
});

describe("parent proof store — bounded, and the mission's alone", () => {
  it("knows nothing until a proof is recorded", () => {
    const store = createParentProofStore();

    expect(store.isProven(JTI, "ticket:1")).toBe(false);
  });

  it("remembers a key it was told about", () => {
    const store = createParentProofStore();
    store.record(JTI, "ticket:1");

    expect(store.isProven(JTI, "ticket:1")).toBe(true);
    expect(store.isProven(JTI, "ticket:2")).toBe(false);
  });

  /**
   * A proof is a fact about ONE mission's scope. Another mission — even the same
   * agent, one token later — has its own scope, so it must pay for its own
   * probe rather than inherit a verdict nothing re-checked.
   */
  it("never lends a proof to another mission", () => {
    const store = createParentProofStore();
    store.record(JTI, "ticket:1");

    expect(store.isProven("jti-2", "ticket:1")).toBe(false);
  });

  /** The jti and the key are composed unambiguously, never concatenated. */
  it("cannot be tricked by a key that spells another mission's entry", () => {
    const store = createParentProofStore();
    store.record("a", "b:c");

    expect(store.isProven("a:b", "c")).toBe(false);
    expect(store.isProven("ab", "c")).toBe(false);
  });

  it("forgets a proof older than the longest mission", () => {
    let clock = 0;
    const store = createParentProofStore({
      now: (): number => clock,
      ttlMs: 1_000,
    });
    store.record(JTI, "ticket:1");

    clock = 1_001;
    expect(store.isProven(JTI, "ticket:1")).toBe(false);
  });

  it("evicts the oldest proofs rather than growing without bound", () => {
    const store = createParentProofStore({ max: 2 });
    store.record(JTI, "ticket:1");
    store.record(JTI, "ticket:2");
    store.record(JTI, "ticket:3");

    expect(store.isProven(JTI, "ticket:1")).toBe(false);
    expect(store.isProven(JTI, "ticket:2")).toBe(true);
    expect(store.isProven(JTI, "ticket:3")).toBe(true);
  });

  /**
   * A proof may not outlive the mission that bought it. The mint caps a mission
   * at 60 minutes, so a TTL at or under that cap is what makes "dies with the
   * mission" true rather than merely intended.
   */
  it("never outlives the longest mission a proxy will mint", () => {
    expect(PARENT_PROOF_TTL_MS).toBeLessThanOrEqual(MAX_TTL_SECONDS * 1000);
  });

  it("re-recording a key refreshes nothing it should not", () => {
    let clock = 0;
    const store = createParentProofStore({
      now: (): number => clock,
      ttlMs: 1_000,
      max: 2,
    });
    store.record(JTI, "ticket:1");
    clock = 500;
    store.record(JTI, "ticket:1");
    store.record(JTI, "ticket:2");

    // One key, one entry: a re-recorded proof must not consume the bound twice.
    expect(store.isProven(JTI, "ticket:1")).toBe(true);
    expect(store.isProven(JTI, "ticket:2")).toBe(true);
  });
});
