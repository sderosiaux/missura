import { existsSync } from "node:fs";
import {
  feasibilityReport,
  loadOrCreateKey,
  loadVault,
  type EntityGraphReader,
  type FeasibilityReport,
  type LinkSystem,
  type VaultData,
} from "@missura/core";
import { ALL_OPERATIONS } from "@missura/proxy";
import { ZENDESK_BASE, ZENDESK_CREDENTIAL } from "./init-zendesk";
import type { MissuraPaths } from "./paths";

/**
 * WHAT THIS DEPLOYMENT IS: the connections `missura init` wrote, read back
 * from the one place they live. The vault is the truth about which vendors
 * this install can reach — a side file saying "zendesk: yes" could drift from
 * it, and the gap report (M9) must not tell an operator to `missura init` a
 * connection they already have, or that a link will work on one they do not.
 *
 * Opening the vault decrypts vendor credentials into THIS process, the
 * operator's own — the same thing `missura run` does — and nothing here hands
 * them on: the callers read the connection NAMES and drop the rest.
 */
export function openVault(paths: MissuraPaths): VaultData {
  if (!existsSync(paths.vaultPath)) {
    throw new Error("vault not found — run missura init");
  }
  return loadVault(paths.vaultPath, loadOrCreateKey(paths.vaultKeyPath));
}

/**
 * Linear and GitHub are what `init` refuses to finish without; Zendesk is the
 * optional third, counted only when BOTH its halves are there — half a
 * connection is what `missura run` refuses to boot, so it is not one here.
 */
export function connectedSystems(vault: VaultData): readonly LinkSystem[] {
  const zendesk =
    (vault[ZENDESK_CREDENTIAL] ?? "").length > 0 && (vault[ZENDESK_BASE] ?? "").length > 0;
  return ["linear", "github", ...(zendesk ? (["zendesk"] as const) : [])];
}

/**
 * The gap report as this deployment computes it: this graph, these
 * connections, every operation the product knows. One closure for the three
 * surfaces that ask — `entity show`, `exec --allow`, the operator plane — so
 * they cannot disagree about what is possible.
 */
export function deploymentFeasibility(
  reader: EntityGraphReader,
  connected: readonly LinkSystem[],
): (entity: string, allow: readonly string[]) => FeasibilityReport {
  return (entity, allow) =>
    feasibilityReport({ reader, entity, catalogue: ALL_OPERATIONS, connected, allow });
}
