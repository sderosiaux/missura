# missura

Same API. Smaller permissions. For every agent.

A local proxy that speaks the vendor's API but only inside the boundary of a
short-lived mission a human created — so an agent never holds the credential and
never sees more than the task needs.

The problem it exists for: a support agent across Zendesk, Linear and GitHub is
the easiest one to justify and the hardest one to ship, because it reads every
customer's data on every run while holding one token that opens the whole
workspace. Missura binds each run to a single customer entity instead.

## Status

v0, in progress. Not production-ready. Read-only everywhere.

Working today: mission tokens minted by an operator (never by the agent), the
vault that keeps vendor credentials out of the agent's environment, connectors
for Linear, GitHub and Zendesk, type-driven request narrowing with response
filtering, missura-owned pagination cursors, an entity graph where only a
human-confirmed link widens a mission, and a hash-chained decision log.

## Layout

```
apps/site                 Next.js static landing page (waitlist)
packages/core             mission tokens, entity graph, shared primitives
packages/proxy            the data plane: catalog, narrow, filter, refill
packages/connectors-*     Linear, GitHub, Zendesk
packages/cli              missura exec / token / tail
examples/compat           live compatibility suite against real vendor APIs
```

## Two properties worth knowing about

**A refusal is indistinguishable from absence.** An object outside your mission
answers exactly like an object that does not exist — same status, same headers,
same bytes. Otherwise guessing identifiers would tell an agent which customers
are real.

**A mission degrades, it never blocks.** If a cross-system link has not been
confirmed by a human, that system is simply not in the mission and the agent is
told which ones are missing. A ticket arriving at 3am does not wait for someone
to approve a mapping.

## What `exec` does and does not protect

`missura exec` removes `LINEAR_API_KEY` and `GITHUB_TOKEN` from the child's
environment and hands it a short-lived mission token instead, so an agent that
reaches for a vendor key by habit finds nothing and goes through the proxy —
where the request is cataloged, narrowed, logged, and revocable.

It is not a sandbox. The child runs as the same user, so it can read
`~/.missura`: `operator.key` mints it a mission of its own, and `vault.key`
with `vault.json` decrypts the vendor credentials outright. `exec` removes the
accident, not the capability. An agent you do not trust with your own account
needs real isolation — a container, or a separate user — with `~/.missura`
outside it.

## Dev

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

All three green is the bar for any change.

## License

Apache-2.0 — see [LICENSE](LICENSE).
