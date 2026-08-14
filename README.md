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
