# M1 — Data plane: credentials out of the agent, controlled passthrough

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Every task is TDD: failing test first, minimal code, green, commit. Root `pnpm lint && pnpm test && pnpm build` green before every commit. AGENTS.md is binding.

**Goal:** `missura init` (vendor credentials → encrypted vault) + `missura run` (one proxy port per connector) so that the OFFICIAL Linear SDK and Octokit work through the proxy with ZERO vendor credentials in the agent env — and any uncataloged endpoint is DENIED and logged.

**Architecture:** `packages/core` grows vault/events/keys. New `packages/connectors-linear` (GraphQL catalog), `packages/connectors-github` (REST catalog), `packages/proxy` (pipeline server), `packages/cli` (init/run/token). Pipeline per request: authn (mission token) → catalog decision (ALLOW/DENY, deny by default) → vendor credential injection → forward → passthrough response → decision event. NO narrow/filter yet (M2/M3). Scope-all dev tokens only (real missions = M2).

**New runtime dependency (justified, the only one):** `graphql` (official reference parser) in connectors-linear — parsing GraphQL with regexes would be a security hole.

**Test strategy (two layers):**
- Unit/TDD everywhere with injected fakes (an in-process `fetch` double standing in for the vendor — internal test double, NOT a user-facing mock; the demo never uses it).
- Live integration gated behind `MISSURA_LIVE=1` (uses the developer's real vault): `pnpm demo:m1` is the proof, run by the human on their own workspace.

**Proof of done (run by the human):**
```bash
pnpm demo:m1
# 1. asserts process env contains NO LINEAR_API_KEY / GITHUB_TOKEN
# 2. @linear/sdk viewer + issues query through http://localhost:8481 → real data
# 3. octokit GET /repos/{owner}/{repo} through http://localhost:8482 → real data
# 4. attempts a Linear mutation + GET /user on GitHub → both DENY, both visible in the decision log
```

**Files layout (all new unless noted):**
```text
packages/core/src/vault.ts|vault.test.ts        # AES-256-GCM file vault
packages/core/src/keys.ts|keys.test.ts          # key material load/create, 0600
packages/core/src/events.ts|events.test.ts      # DecisionEvent type + JSONL sink + redaction
packages/core/src/token.ts                      # (exists) + scope-all helper
packages/connectors-linear/src/catalog.ts|.test.ts
packages/connectors-github/src/catalog.ts|.test.ts
packages/proxy/src/pipeline.ts|.test.ts         # pure decision pipeline (no I/O)
packages/proxy/src/server.ts|server.test.ts     # node:http wiring, ports 8481/8482
packages/cli/src/{init,run,token}.ts + cli.ts   # node:util parseArgs, no CLI framework
examples/m1-proof/check.ts                      # the demo:m1 script (root script wires it)
```

---

### Task 1: `packages/core` — key material + vault (TDD)

**Contract:**
```ts
// keys.ts
export function loadOrCreateKey(path: string): Buffer;        // 32 random bytes, file mode 0600, reused if present
// vault.ts
export interface VaultData { [connection: string]: string }    // e.g. { linear: "lin_api_...", github: "ghp_..." }
export function saveVault(path: string, key: Buffer, data: VaultData): void;   // AES-256-GCM, random IV per save, file mode 0600
export function loadVault(path: string, key: Buffer): VaultData;
```
**Tests that must exist (failing first):** round-trip save/load; wrong key → throws (auth tag failure), never returns garbage; IV differs between two saves of same data (ciphertexts differ); created files have mode 0600; `loadVault` on missing file → clear error `vault not found — run missura init`.
**Crypto specifics (non-negotiable):** `crypto.createCipheriv("aes-256-gcm", key, iv)` with 12-byte random IV, auth tag stored alongside (file format: JSON `{iv, tag, data}` all base64). Never log key or plaintext.
Commit: `feat(core): encrypted file vault + key material`

### Task 2: `packages/core` — decision events (TDD)

**Contract:**
```ts
export interface DecisionEvent {
  ts: string; provider: "linear" | "github"; operation: string; action: string;
  decision: "allow" | "deny"; reason: string; missionId: string; latencyMs: number;
}
export function appendEvent(dir: string, ev: DecisionEvent): void;   // JSONL, one file per day
export function formatEventLine(ev: DecisionEvent): string;          // "ALLOW  linear  IssuesQuery" style, colors optional
```
**Tests:** appends valid JSONL (parse back); NEVER contains fields named token/authorization/body even if passed extra properties (redaction by construction: only whitelisted fields serialized); format line contains decision uppercase + provider + operation.
Commit: `feat(core): decision events, JSONL sink, redaction by construction`

### Task 3: `packages/core` — scope-all dev token helper (TDD)

**Contract:** `export function signDevToken(opts: { key: Buffer; ttlSeconds: number }): string` → wraps `signMissionToken` with `{ id: "msn_dev", purpose: "m1 dev token — scope all", scope: {}, connections: ["linear","github"], allow: ["read","search"] }`. Also strengthen claims validation per M0 review leftover: elements of `connections`/`allow` must be strings (test + fix in token.ts).
Commit: `feat(core): dev token helper + claim element validation`

### Task 4: `packages/connectors-linear` — GraphQL catalog (TDD, dep: graphql)

**Contract:**
```ts
export interface CatalogDecision { decision: "allow" | "deny"; operation: string; action: string; reason: string }
export function decideLinear(body: string): CatalogDecision;   // body = raw JSON POST body of /graphql
```
**Rules:** parse `query` with `graphql.parse` — parse error → deny "unparseable". Operation type `mutation`/`subscription` → deny. Query top-level fields must ALL be in allowlist `["issues","issue","customers","customer","projects","project","comments","comment","viewer"]` — any other field → deny naming the field. Aliases resolve to real field name. Fragments at top level: deny in M1 ("fragment at root unsupported"), inline or named. Introspection fields (`__schema`, `__type`) → deny. Multiple operations in one document → deny. `operation` = operation name or first root field.
**Tests (failing first, real query strings):** allowed issues query passes; aliased `myIssues: issues` passes; mutation denies; `teams` field denies with reason containing "teams"; `__schema` denies; two-operations document denies; malformed GraphQL denies; fragment-spread-at-root denies.
Commit: `feat(connectors-linear): deny-by-default GraphQL read catalog`

### Task 5: `packages/connectors-github` — REST catalog (TDD)

**Contract:**
```ts
export function decideGithub(method: string, path: string): CatalogDecision;
```
**Rules:** only `GET`; allowlist patterns: `/repos/{owner}/{repo}`, `/repos/{owner}/{repo}/issues`, `/repos/{owner}/{repo}/issues/{n}`, `/repos/{owner}/{repo}/issues/{n}/comments`, `/repos/{owner}/{repo}/pulls`, `/repos/{owner}/{repo}/pulls/{n}`, `/repos/{owner}/{repo}/contents/{path...}`, `/search/issues`. Everything else deny (`/user`, `/repos/{o}/{r}/zipball`, POST anything…). Path params extracted into `operation` (e.g. `repos.issues.list`).
**Tests:** each allowed pattern allows; `/user` denies; `POST /repos/.../issues` denies; `/repos/o/r/zipball/main` denies; trailing-slash and query-string variants handled.
Commit: `feat(connectors-github): deny-by-default REST read catalog`

### Task 6: `packages/proxy` — pipeline + server (TDD, the hard one)

**Contract (pure pipeline, fully unit-testable, fetch injected):**
```ts
export interface PipelineDeps {
  verifyToken(token: string): MissionClaims;          // from core
  decide(req: { method: string; path: string; body: string }): CatalogDecision;
  vendorAuthHeader(): string;                          // e.g. `Bearer <vendor key>` — read from vault ONCE at boot, never per request-log
  upstreamBase: string;                                // https://api.linear.app or https://api.github.com
  fetchImpl: typeof fetch;
  emit(ev: DecisionEvent): void;
}
export async function handle(deps: PipelineDeps, req: IncomingShape): Promise<ResponseShape>;
```
**Pipeline order (tests pin each):** (1) missing/invalid/expired Bearer token → 401, NO upstream call, event decision=deny reason=authn. (2) catalog deny → 403 JSON `{error:{code:"missura_denied", reason}}`, NO upstream call, event logged. (3) allow → forward to upstream: same method/path/query/body, headers passed through EXCEPT `Authorization` replaced by `vendorAuthHeader()` and `host` dropped; response streamed back with status + content-type intact; event decision=allow with latency. (4) upstream network error → 502 `{error:{code:"missura_upstream_error"}}` — no vendor details leaked. (5) The vendor credential NEVER appears in any event or error payload (test asserts).
**Server (`server.ts`):** node:http, two listeners (8481→linear deps, 8482→github deps), body size cap 10 MB (413 above), graceful shutdown. Tests via real http against a local stub upstream server (node:http fixture in test — internal double).
Commit: `feat(proxy): authn → catalog → inject → forward pipeline + dual-port server`

### Task 7: `packages/cli` — init / run / token (TDD where logic exists)

**Contract:** `missura init` prompts (or reads env `MISSURA_INIT_LINEAR_KEY`/`MISSURA_INIT_GITHUB_TOKEN` for non-interactive) → saves vault + generates signing key + operator marker; prints NOTHING sensitive. `missura run` boots both listeners from vault (fails with clear message if vault missing). `missura token --ttl 3600` prints a dev scope-all token (reads signing key). `node:util parseArgs`, no framework. Files under `~/.missura/` overridable via `MISSURA_HOME` (tests use tmp dirs).
**Tests:** init then run in tmp MISSURA_HOME boots and serves 401 on tokenless request; token command output verifies with the same key; init refuses empty credentials.
Commit: `feat(cli): init, run, token — vault-backed boot`

### Task 8: proof script + workspace wiring

`examples/m1-proof/check.ts` (devDeps: `@linear/sdk`, `octokit`): asserts `!process.env.LINEAR_API_KEY && !process.env.GITHUB_TOKEN`; builds Linear client with `apiUrl: http://localhost:8481/graphql` + dev token; Octokit with `baseUrl: http://localhost:8482`; runs viewer + issues(first:3) + repo GET; then a mutation attempt + `/user` GET expecting missura_denied; prints a PASS/FAIL table. Root script: `"demo:m1": "MISSURA_LIVE=1 tsx examples/m1-proof/check.ts"` (tsx as devDep). CI does NOT run it (gated).
Commit: `feat(examples): m1 proof — official SDKs through the proxy, zero vendor creds in env`

### Task 9: SPEC status + final review + merge

Update `docs/SPEC.md` M1 line `— DONE <date>` ONLY after the human confirms `pnpm demo:m1` passes on a real workspace. Final code review (fresh reviewer) over `git diff main...m1-data-plane` before merge.
