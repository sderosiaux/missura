# M3 — The semantic engine

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Every task is TDD: failing test first, minimal code, green, commit. Root `pnpm lint && pnpm test && pnpm build` green before every commit. AGENTS.md is binding.

**Goal:** replace M2's hand-written path allowlist with schema-driven, type-aware enforcement, and move the enforcement point from "refuse the request" to "let it run and filter the response". The milestone is done when the OFFICIAL `@linear/sdk` typed methods work under a customer-scoped mission and return zero out-of-scope objects.

**Why this shape (read before designing anything):** a request-side refusal costs agent turns; a filtered response costs nothing. See `docs/SPEC.md` §4.4.2. Refuse before the call ONLY when filtering afterwards cannot repair it: (1) writes/side effects, (2) a type the connector has not classified, (3) a non-nullable field that would have to be removed (breaks the vendor schema, so the SDK crashes), (4) an aggregate/count that cannot be recomputed from the authorized objects.

**Schema source (decided, do not redesign):** `node_modules/@linear/sdk/dist/index.d.mts` contains the SDK's generated class declarations, which carry field names, types and nullability (`x: T` vs `x?: T | null`). That is a pinned, dependency-versioned schema source needing no network and no credentials. We extract from it into a committed artifact; drift is detected when the dependency moves. NO live introspection, NO use of the user's vendor credentials.

**Fail-closed rule, everywhere in this milestone:** an unknown type, an unknown field, or an unresolvable owner is a DENY, never a pass. An incomplete curated map must make the product restrictive, never unsafe.

---

### Task 1 — Linear schema artifact + type classification

**Files:** `packages/connectors-linear/src/schema/extract.ts` (dev script), `schema.json` (committed artifact), `schema.ts` (accessors), `classification.ts`, plus tests.

**Contract:**
```ts
export interface FieldInfo { type: string; nullable: boolean; list: boolean }
export function fieldInfo(parentType: string, field: string): FieldInfo | undefined  // undefined ⇒ deny
export type TypeClass = "customer-scoped" | "metadata" | "denied"
export function typeClass(type: string): TypeClass                                   // unknown ⇒ "denied"
export function ownerPath(type: string): readonly string[] | undefined               // how to reach the owning customer id
```
- `extract.ts` parses the SDK declarations and writes `schema.json`. Wire it as root script `schema:refresh`. It must be deterministic (stable key order) so a dependency bump produces a reviewable diff. It is NOT run at runtime — the committed `schema.json` is.
- **Curated classification (human judgment, this is the connector's value):** customer-scoped = `Issue`, `Customer`, `Comment`, `Attachment`, `CustomerNeed`(if present); metadata = `Team`, `WorkflowState`, `IssueLabel`, `User`, `Cycle`, `Project`, `ProjectMilestone`, `Organization`, `Reaction`, `Favorite`, `IssueRelation`(scalars only), `PageInfo`, and the connection wrappers. Everything else ⇒ `denied`.
  **VERIFY, do not assume:** for each type you classify as metadata, confirm from the schema that it carries no field that returns a customer-scoped type as a *collection* (e.g. `Team.issues`). If it does, it stays reachable ONLY as a leaf-scalar selection — the request-side walk (Task 2) must deny a collection under it. State in a comment, per type, why it is safe.
- `ownerPath`: `Issue` → `["customer","id"]`; `Comment` → `["issue","customer","id"]`; `Attachment` → `["issue","customer","id"]`; `Customer` → `["id"]`.
**Tests:** extraction is deterministic; `fieldInfo("Issue","team")` returns the Team type and its nullability matching the SDK declaration; unknown type/field ⇒ undefined; `typeClass` unknown ⇒ "denied"; every classified metadata type has a comment-documented justification and no unguarded collection of a customer-scoped type.
Commit: `feat(connectors-linear): pinned schema artifact and type classification`

### Task 2 — Type-driven request narrowing (replaces the path allowlist)

**Files:** `packages/connectors-linear/src/narrow*.ts` (rework), `packages/core/src/filter-plan.ts` (new shared contract).

**Shared contract (in @missura/core so the proxy and every connector share it):**
```ts
export interface FilterRule {
  path: readonly string[];        // response path, "*" for every element of a list
  type: string;                   // the type of the object at that path
  ownerPath: readonly string[];   // relative path from that object to the owning customer id
  expectedOwnerId: string;
  injected: readonly string[];    // fields WE added at that path and must strip on the way out
  nullable: boolean;              // may a foreign single object be replaced by null?
}
export interface FilterPlan { rules: readonly FilterRule[]; strip: readonly (readonly string[])[] }
```
**Behaviour (replaces the M2 traversal allowlist entirely):** walk the selection set using the schema. For each field: resolve its type via `fieldInfo`; unknown ⇒ deny. `metadata` ⇒ allow, and keep walking (a collection of a customer-scoped type under a metadata type ⇒ deny — that is the `Team.issues` escape M2 closed by path, now closed by type). `customer-scoped` ⇒ allow, and ensure the owner discriminator is selected (inject it if absent, record it in `injected`), then emit a `FilterRule` for that response path. `denied` ⇒ deny.
Keep the NARROW that already exists (inject the customer filter into `issues`) — it is cheaper than filtering. Keep every M2 protection that is not about the allowlist: fragment resolution, alias handling, `extensions` stripping, multi-operation deny, mutation deny, `Object.hasOwn` guards.
**Tests:** the M2 isolation table (`narrow-isolation.test.ts`) must still pass — `team { issues { … } }` still denies, now by type. NEW: the SDK's own fat fragment (read the real generated document out of `@linear/sdk` at test time, do not hand-copy it) is ALLOWED and produces a FilterPlan covering every customer-scoped path it selects. `viewer` scalars still allowed; `viewer { assignedIssues }` now denies by type, not by name.
Commit: `feat(connectors-linear): type-driven narrowing, filter plans instead of a path allowlist`

### Task 3 — Response FILTER engine

**Files:** `packages/proxy/src/filter.ts` (new), wired into the pipeline after `forward`, replacing the ad-hoc `applyPostCheck`.

**Behaviour:** apply a `FilterPlan` to the parsed response. For each rule: at a list path, drop every element whose owner ≠ `expectedOwnerId`; at a single-object path, replace a foreign object with `null` if `nullable`, else this is a case the request-side walk must have denied — if it happens anyway, fail closed (return the vendor-shaped "not found" and log a deny with reason `unfilterable`). Strip everything in `injected`/`strip`. An object whose owner cannot be resolved (missing/null discriminator) is FOREIGN — remove it. Preserve the response shape otherwise, byte-for-byte where untouched.
**Tests:** foreign objects dropped from a list; foreign single object nulled; unresolvable owner treated as foreign; injected discriminator stripped but an agent-requested one kept (the M2 `injectedSelection` semantics, now generalized); a response with nothing to filter is returned unchanged; non-JSON or unparseable body fails closed.
Commit: `feat(proxy): response filter engine driven by connector filter plans`

### Task 4 — Pagination REFILL

**Files:** `packages/proxy/src/refill.ts` (new) + pipeline wiring.

**Why it is not optional:** filtering 50 issues down to 12 breaks the SDK's pagination helpers and leaks how many objects were hidden (`totalCount`, `hasNextPage`).
**Behaviour (bounded, M3 scope):** after filtering a connection, if fewer authorized objects remain than the requested page size AND the upstream reports another page, re-issue the upstream request with the next cursor and merge — up to a hard cap (max 5 extra upstream calls or 10 s, whichever first; both constants exported and tested). Then rewrite `pageInfo` to describe what WE return, and strip or recompute any total/count field. Every extra upstream call is its own decision event (so the audit shows the real vendor load).
**Deferred explicitly (write it in the code comment):** missura-owned opaque logical cursors (SPEC §22). M3 passes through the last upstream cursor it used.
**Tests:** a short filtered page triggers refill and returns the requested count when enough authorized objects exist; the cap stops the loop and the response is honest about it (`hasNextPage` true); `totalCount` is never the vendor's raw number; each refill call emits its own event.
Commit: `feat(proxy): bounded pagination refill so filtering does not break SDK cursors`

### Task 5 — GitHub: filter instead of refuse, and relay the vendor headers

**Files:** `packages/connectors-github/src/narrow.ts` (search), `packages/proxy/src/forward.ts` (headers).

- **Search:** delete the boolean-syntax refusal added in M2. Let the query run, and return a `FilterPlan` that keeps only results whose `repository.full_name` is in the mission repos, recomputing `total_count` and setting `incomplete_results` honestly. Keep forcing the mission `repo:` qualifiers when the query is simple (cheaper than filtering); when it is not, rely on the filter. Quoted phrases and `OR` are legitimate again.
- **Vendor headers:** today only `content-type` is relayed, so `x-ratelimit-*`, `x-github-request-id`, `retry-after` are lost and SDK retry logic flies blind (SPEC §12 violation shipped in M1). Relay an explicit allowlist. **Careful:** GitHub's `link` header describes vendor pagination, which our filtering invalidates — strip it when a filter plan applied to the response, and say why in a comment.
**Tests:** the M2 boolean exploit (`q=is:issue OR repo:globex/secret`) now ALLOWS the request and returns zero globex results with a corrected `total_count`; a quoted phrase works; ratelimit headers reach the client; `link` is stripped on a filtered response and preserved on an unfiltered one.
Commit: `feat(connectors-github): filter search results instead of refusing queries; relay vendor headers`

### Task 6 — Actionable errors

**Files:** `packages/core/src/remediation.ts` (new), wired everywhere a deny is produced (`pipeline.ts`, both connectors).

**Contract (SPEC §4.8bis):** every refusal keeps the VENDOR-shaped envelope the SDK expects (GraphQL `{"errors":[{message, extensions}]}`, GitHub `{"message": …}`) and carries the missura block under `extensions.missura` / a `missura` key: `{code, reason, mission:{scope, allowed_actions, expires_in}, remediation, try_instead[], introspect}`.
**Non-negotiable non-leak rule:** the remediation is derived from the mission the agent ALREADY knows, never from the denied target. "Your mission covers customer:acme — drop the `team` field" is allowed. "ISS-12 belongs to globex" is not: it would confirm an out-of-scope object exists and turn our errors into an enumeration oracle. Add a test that asserts no denied identifier, repo name, or foreign owner id ever appears in a remediation payload.
**Tests:** each deny path produces a vendor-parseable envelope; the missura block carries scope + a concrete `try_instead`; the leak test above; the `@linear/sdk` does not crash on a denied response (drive a real denied call through the SDK in a test).
Commit: `feat(core): actionable, vendor-shaped denials that teach the agent its boundary`

### Task 7 — `demo:m3` (human-run proof)

`examples/m3-proof/check.ts` + root script `demo:m3` (`MISSURA_LIVE=1` gated, standalone, no `@missura` import). Checks, on a real workspace: (1) env carries no vendor credentials; (2) **the official `@linear/sdk` typed methods** — `linear.issues({first:5})`, `linear.issue(id)` — succeed and every returned object belongs to the mission customer; (3) SDK pagination over a filtered set returns the requested count and its cursor keeps working; (4) a GitHub search with `OR` and a quoted phrase runs and returns only mission repos, with a corrected total; (5) a denied call returns a vendor-parseable error whose remediation names the mission scope and no foreign identifier; (6) ratelimit headers are visible to the client. PASS/FAIL table, non-zero exit on failure.
Commit: `feat(examples): m3 proof — the official SDK working inside a scoped mission`

### Task 8 — Review and merge

Fresh adversarial security review over `git diff main...m3-semantic-engine` (attacker goal unchanged: read another customer's data). Then a Codex review. Fix findings. Merge, push, CI green. `docs/SPEC.md` M3 → DONE only after the human runs `demo:m3`.
