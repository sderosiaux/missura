# missura

Same API. Smaller permissions. For every agent.

A local proxy that speaks the vendor's API but only inside the boundary of a
short-lived mission a human created — so an agent never holds the credential and
never sees more than the task needs.

## Status

v0, in progress. Currently at **M0**: monorepo scaffolding, the mission token
primitive, and the landing page. Nothing here is production-ready yet.

## Layout

```
apps/site       Next.js static landing page (waitlist)
packages/core   mission tokens and shared primitives — no app imports
docs/SPEC.md    source of truth for the v0 implementation
```

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
outside it (docs/SPEC.md §3).

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
