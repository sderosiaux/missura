import { randomBytes } from "node:crypto";
import type { DecisionEvent } from "@missura/core";
import { describe, expect, it } from "vitest";
import { passThroughNarrow } from "./narrow";
import type { ConnectionConfig, ProxyConfig } from "./server";

const sink: DecisionEvent[] = [];
const noop = (ev: DecisionEvent): void => {
  // The audit sink is not what these assertions are about.
  sink.push(ev);
};

function connection(): ConnectionConfig {
  return { vendorAuthHeader: "Bearer vendor", narrow: passThroughNarrow };
}

/**
 * These assertions are made by `tsc`, not by the runtime: absence of a policy
 * input must not be spellable at all. A `narrow` that could be left out meant
 * "no narrowing", and an `isRevoked` that could be left out meant "nothing is
 * revoked" — both of them a missing policy input defaulting to PASS, which is
 * the one thing the proxy is not allowed to do (AGENTS.md, docs/SPEC.md §2).
 */
describe("ProxyConfig — a missing policy input is not spellable", () => {
  it("refuses a connection without a NARROW", () => {
    // @ts-expect-error — `narrow` is required: no NARROW is not pass-through.
    const withoutNarrow: ConnectionConfig = { vendorAuthHeader: "Bearer x" };
    expect(withoutNarrow.vendorAuthHeader).toBe("Bearer x");
  });

  it("refuses a proxy config without a revocation list", () => {
    // @ts-expect-error — `isRevoked` is required: no list is not "nothing revoked".
    const withoutRevocation: ProxyConfig = {
      signingKey: randomBytes(32),
      emit: noop,
      linear: connection(),
      github: connection(),
    };
    expect(withoutRevocation.github.vendorAuthHeader).toBe("Bearer vendor");
  });
});
