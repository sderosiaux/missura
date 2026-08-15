# M2 — Real missions, exec, NARROW

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Every task is TDD: failing test first, minimal code, green, commit. Root `pnpm lint && pnpm test && pnpm build` green before every commit. AGENTS.md binding.

**Goal:** Missions become real: minted by an operator-authenticated API (`/v1/token`), scoped to a business entity, carried by `missura exec`, enforced by NARROW (Linear customer filter injected in the AST, GitHub repo allowlist), with 404 out-of-scope, revocation < 5 s, and `actor`/`purpose`/`traceparent` in every provenance event.

**Definition of done (spec M2):** a `customer:acme` mission cannot read any other customer's object via direct query, global search, or guessed ID — verified live on a real workspace by the human (`demo:m2`).

**Architecture additions:**
- `packages/core`: mission store (create/get/revoke, jti revocation list persisted, expiry), operator key, entity map loader.
- `packages/proxy`: new operator listener on **8480** (`POST /v1/token`, `POST /v1/revoke`) + pipeline gains revocation check, scope resolution, NARROW hooks per connector, `traceparent` passthrough, `actor`/`purpose` in events.
- `packages/connectors-linear`: NARROW — rewrite the GraphQL document/variables to inject the mission's customer filter; per-root-field scope policy.
- `packages/connectors-github`: mission repo allowlist → out-of-mission repo = **404** (anti-enumeration), `repo:` qualifier forced into `/search/issues`.
- `packages/cli`: `missura exec`, `missura revoke`, `missura missions`; `missura token` (dev) now requires an explicit `--dev` flag and prints a deprecation note.
- Entity map: `~/.missura/entities.json` (JSON not YAML — zero new deps; spec shows YAML, deviation documented) shape:
```json
{ "customer:acme": { "linear.customer": "c_18", "github.repos": ["acme-corp/product"] } }
```

**Scope policy under a customer-scoped mission (deny-by-default decisions, binding):**
| Linear root field | Behavior |
|---|---|
| `issues` (list) | NARROW: inject `filter: { customer: { id: { eq: <mapped id> } } }` merged with agent filter (agent's own narrower filters kept; conflicting broader `customer` filter overwritten) |
| `issue(id)` | Forward, then **post-check**: response's `issue.customer.id` must equal the mapped id, else **404-shaped GraphQL error** (`issue not found`) — a deliberate M2 slice of response verification for single objects; requires the query to include the customer relation: rewrite the selection set to ADD `customer { id }` if absent, and STRIP it from the response if it was added by us |
| `customers` / `customer(id)` | Only the mission's mapped customer id; `customers` list → deny ("use customer(id)"), `customer(id)` with any other id → 404-shaped error pre-vendor |
| `viewer` | Allow (self-identity, harmless) |
| `projects`/`project`/`comments`/`comment` | **Deny under customer scope** in M2 (no provable customer relation yet — reason: "no proven relation to mission customer") |
| Missions WITHOUT customer scope (repos-only) | Linear connector denies everything except `viewer` (reason "linear not in mission scope") |

| GitHub | Behavior |
|---|---|
| Catalog-allowed path on a mission repo | Allow |
| Catalog-allowed path on any other repo | **404** `{"message":"Not Found"}` (GitHub-shaped, anti-enumeration) + deny event |
| `/search/issues` | Force `repo:owner/name` qualifiers for mission repos into `q` (strip any agent-supplied `repo:`/`org:`/`user:` qualifiers) |
| Mission without repos | All GitHub → 404-shaped deny |

---

### Task 1: core — mission store + revocation + operator key (TDD)

**Contract (`packages/core/src/missions.ts`):**
```ts
export interface MissionScope { customer?: string; repos?: string[] }
export interface CreateMission { purpose: string; actor: string; scope: MissionScope; ttlSeconds: number }
export interface MissionRecord extends CreateMission { id: string; jti: string; createdAt: number; expiresAt: number; revokedAt?: number }
export class MissionStore {
  constructor(stateFile: string, signingKey: Buffer)
  create(input: CreateMission): { record: MissionRecord; token: string }   // token = signMissionToken with scope+purpose+actor claims, connections derived: linear iff scope.customer, github iff scope.repos?.length
  revoke(idOrJti: string): MissionRecord                                   // persists immediately (sync write)
  isRevoked(jti: string): boolean
  active(): MissionRecord[]                                                // non-expired, non-revoked
}
```
Claims: extend `MissionInput` with `actor: string` (validated non-empty string). `purpose` required non-empty. Revocation list persisted to the state file on every revoke (sync), reloaded on construction — a new process sees prior revocations.
**Tests:** create→token verifies and carries actor/purpose/scope; connections derived correctly for customer-only / repos-only / both; revoke persists across a new MissionStore instance; isRevoked true immediately after revoke (timing test: < 100 ms); active() excludes expired and revoked; empty purpose/actor rejected; ttl > 3600 rejected (reuses cap).
Operator key: `loadOrCreateKey` reused at `~/.missura/operator.key` (no new code; test that init creates it — CLI task).
Commit: `feat(core): mission store, persisted revocation, actor claim`

### Task 2: core — entity map loader (TDD)

**Contract (`packages/core/src/entities.ts`):**
```ts
export interface EntityMapping { linearCustomerId?: string; githubRepos?: string[] }
export function loadEntityMap(path: string): Map<string, EntityMapping>   // entities.json; missing file → empty map; malformed → throw naming the offending key
export function resolveScope(map: Map<string, EntityMapping>, scope: MissionScope): ResolvedScope
export interface ResolvedScope { linearCustomerId?: string; githubRepos: string[] }
```
`resolveScope`: `scope.customer` → must exist in map (else throw `unknown entity: customer:acme`); its `githubRepos` UNION `scope.repos` (explicit repos add to the entity's). Repo names validated `owner/name` lowercase-insensitive match.
**Tests:** load round-trip; missing file → empty; unknown customer throws; union of repos; malformed JSON/shape errors name the key.
Commit: `feat(core): entity map — entities.json loader and scope resolution`

### Task 3: proxy — operator API listener (TDD)

**Contract (`packages/proxy/src/operator.ts`):** node:http listener (default port 8480, 127.0.0.1) with deps injected `{ store: MissionStore, resolve(scope): ResolvedScope, operatorKey: Buffer }`.
- Authn: `Authorization: Bearer <hex of operator.key>` compared via timingSafeEqual → else 401. No other auth in M2.
- `POST /v1/token` body: `{ grant_type: "client_credentials", authorization_details: [{ type: "mission", purpose, actor, scope: { customer?, repos? }, ttl }] }` → 200 `{ mission_id, access_token, expires_in, proxy_origins: { linear, github } }`. Validation errors → 400 with field name. Unknown entity → 400.
- `POST /v1/revoke` body `{ token }` (the msr_ token) or `{ mission_id }` → 200 `{ revoked: true }` (RFC 7009 semantics: revoking twice = still 200).
- `GET /v1/missions` → active missions (id, purpose, actor, scope, expiresAt) — NO tokens in the response.
- Anything else → 404. Operator key NEVER in any response/event.
**Tests:** full round-trip create→verify token claims; bad operator key 401 via real HTTP; revoke by token and by id; double revoke 200; validation errors; missions listing has no token material.
Commit: `feat(proxy): operator API — /v1/token, /v1/revoke, /v1/missions on 8480`

### Task 4: proxy pipeline — revocation, scope, traceparent, event enrichment (TDD)

Changes to `packages/proxy/src/pipeline.ts` + `server.ts`:
- `PipelineDeps` gains `isRevoked(jti): boolean` and `narrow(req, claims): NarrowResult` (see Task 5/6 contracts) — revoked jti → 401 `missura_unauthorized` (reason `revoked`), checked right after verify. Timing: revocation visible on the very next request (no cache).
- `traceparent` request header: passed through to the vendor unchanged (it's currently dropped? verify — hop-by-hop list must NOT include it) and copied into the decision event as `traceId` (parse the trace-id field; malformed → omit).
- Events gain `actor` and `purpose` from claims (extend DecisionEvent whitelist in core — fields serialize).
- NARROW integration: connector `narrow` runs after catalog-allow, may rewrite path/body/q, may itself DENY (event reason from it), may register a post-check applied to the response before returning it (used by Linear issue(id) ownership check → 404-shaped body swap).
**Tests:** revoked token → 401 no upstream; traceparent forwarded + in event; actor/purpose in JSONL; narrow-deny path; post-check replacing an out-of-scope single-object response with the 404 shape (fake upstream double returns a globex-owned issue; client sees `issue not found` GraphQL error, event decision deny reason `out-of-scope object`).
Commit: `feat(proxy): revocation in the hot path, traceparent, actor/purpose provenance, narrow hooks`

### Task 5: connectors-linear — NARROW (TDD, the hard one)

**Contract (`packages/connectors-linear/src/narrow.ts`):**
```ts
export interface LinearNarrowResult { decision: "allow" | "deny"; body?: string; reason?: string; postCheck?: { path: string[]; expectedCustomerId: string; injectedSelection: boolean } }
export function narrowLinear(body: string, scope: { linearCustomerId?: string }): LinearNarrowResult
```
Implements the scope-policy table above by AST manipulation (graphql `parse`/`print`/`visit`):
- `issues`: build/merge the `filter` argument — agent filter preserved via `and: [...]`, any agent-supplied `customer` sub-filter REPLACED by ours; works with inline args AND `variables` (if the filter comes via `$variables`, rewrite the variables JSON instead).
- `issue(id)`: ensure `customer { id }` in the selection (record `injectedSelection: true` when added), postCheck path `["data","issue","customer","id"]`.
- `customer(id)` wrong id → deny pre-vendor (404-shaped). `customers` list → deny. `viewer` allow untouched. Others per table.
- No `linearCustomerId` in scope → deny all but `viewer`.
**Tests (real query strings, assert on printed AST / rewritten variables):** filter injected inline; filter injected into variables; agent's `assignee` filter preserved under `and`; agent's broader `customer` filter overwritten; issue(id) selection injection + postCheck descriptor; customer(other) denied; viewer untouched; projects denied with reason; repos-only scope denies issues.
Commit: `feat(connectors-linear): NARROW — mission customer filter injected into the AST`

### Task 6: connectors-github — mission repo scope (TDD)

**Contract (`packages/connectors-github/src/narrow.ts`):**
```ts
export interface GithubNarrowResult { decision: "allow" | "deny"; path?: string; denyShape?: "github404"; reason?: string }
export function narrowGithub(path: string, scope: { githubRepos: string[] }): GithubNarrowResult
```
- `/repos/{owner}/{repo}/...`: owner/repo (case-insensitive) must be in scope → else deny with `denyShape: "github404"` (proxy responds 404 `{"message":"Not Found"}` + deny event).
- `/search/issues?q=...`: strip agent `repo:`/`org:`/`user:` qualifiers from `q`, append `repo:x` for every mission repo; empty scope → deny github404. Return rewritten `path`.
- Pipeline wires `denyShape` to the GitHub-shaped 404 response.
**Tests:** in-scope repo passes; other repo → github404; case-insensitivity; search q rewritten (agent qualifiers stripped, mission repos appended, other terms kept, URL-encoding intact); no-repos scope → github404 everywhere.
Commit: `feat(connectors-github): NARROW — mission repo allowlist, 404 anti-enumeration, forced search qualifiers`

### Task 7: CLI — exec, revoke, missions (TDD)

- `missura exec --customer acme --repo owner/name --ttl 30m --purpose "support case" -- <cmd...>`: reads operator key locally, creates the mission via MissionStore directly (same code path as the API), spawns `<cmd>` with env `MISSION_TOKEN`, `LINEAR_API_URL`, `GITHUB_API_URL` (+ inherits parent env MINUS `LINEAR_API_KEY`/`GITHUB_TOKEN` — actively stripped), forwards exit code, on SIGINT revokes the mission. `--ttl` accepts `30m`/`1800`/`45s` formats, cap 60m. `--actor` defaults to `$USER@local`.
- `missura revoke <mission_id>`; `missura missions` (table: id, purpose, actor, scope, TTL left).
- `missura token` now requires `--dev` (refuses without, pointing at exec) — the M1 shortcut is fenced.
- `missura run` boots operator listener (8480) alongside the two data listeners; wires isRevoked + narrow + entity map (loaded at boot; `--entities <path>` override).
**Tests:** exec spawns a child that sees MISSION_TOKEN and does NOT see a planted LINEAR_API_KEY from parent env; exit code forwarded; ttl parsing (30m/1800/bad); token without --dev fails with pointer; revoke+missions round-trip on tmp home.
Commit: `feat(cli): exec — mission-wrapped agent runs; revoke; missions; fenced dev token`

### Task 8: demo:m2 — the live proof (human-run)

`examples/m2-proof/check.ts` (+ root script `demo:m2` = `MISSURA_LIVE=1 tsx examples/m2-proof/check.ts`). Requires: proxy running, `~/.missura/entities.json` configured by the human with a REAL customer of their Linear workspace + one of their repos, and env `MISSURA_TOKEN` minted via `missura exec`-style mission (helper printed in the script header: `missura exec --customer <x> --ttl 15m -- env | grep MISSION_TOKEN`... simpler: script accepts operator flow: reads MISSURA_TOKEN).
Checks: (1) env has no vendor creds; (2) `issues` unfiltered query → every returned issue's customer.id == mapped id (asserts on data); (3) global search attempt (issues with an explicit other-customer filter) → still only mission customer back; (4) guessed `issue(id)` of an out-of-scope issue (env `MISSURA_FOREIGN_ISSUE_ID`, optional — SKIP if unset) → `issue not found`; (5) GitHub in-scope repo GET → data; (6) other repo (octokit/octokit.js unless it IS the scope) → 404; (7) `/search/issues` q=`anything repo:golang/go` → results only from mission repos (assert repository fields); (8) revoke mid-run: script calls `/v1/revoke` (needs OPERATOR_KEY env… NO — the agent must not hold it; instead the script PROMPTS the human: "run `missura revoke <id>` now, press enter" then asserts the next call is 401 within 5 s). PASS/FAIL table, exit code.
Commit: `feat(examples): m2 proof — scoped mission on a real workspace, revocation live`

### Task 9: review + merge + gate

Fresh final security review over `git diff main...m2-missions` (attacker-first: filter-merge escapes, variables vs inline args, search qualifier smuggling, revocation races, operator key handling). Fix findings. Merge, push, CI green. `docs/SPEC.md` M2 → DONE only after the human's `demo:m2` passes.
