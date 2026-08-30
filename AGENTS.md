# missura — engineering rules (agents included)

- TDD non-negotiable: failing test first, minimal code, green, commit. No code without a test.
- TypeScript strict everywhere (`tsconfig.base.json`). `any` is a lint error. Explicit return types in packages/.
- Files stay under 300 lines; one responsibility per file; packages never import from apps.
- Security invariants: agents never mint missions; vendor credentials never cross into agent-facing code paths; deny by default — an uncataloged endpoint must fail closed, and a failing policy check must never fall through to PASS.
- No new runtime dependencies without a written reason in the PR/commit body.
- Never log secrets or full request/response bodies. Redact by default.
- Verify before done: `pnpm lint && pnpm test && pnpm build` green locally is the definition of done for every task.
- Commits: conventional (`feat:`, `fix:`, `chore:`), authored by the repo owner only.
