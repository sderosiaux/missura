import type { Operation } from "@missura/core";

/**
 * What serving operations needs beyond one connector's own pipeline. Held on
 * every listener, because the agent-facing routes (`/missura/mission`, and
 * `/missura/op/<name>` from M7) answer on any listener the agent aims at.
 */
export interface OperationsDeps {
  /**
   * Every operation this proxy can run, across its connectors. Introspection
   * filters it down to what the mission reaches; nothing lists it whole to an
   * agent.
   */
  catalogue: readonly Operation[];
}
