# Semantic Access Proxy — landing page

Waitlist landing page for Missura (Semantic Access Proxy) (see `../spec.md`).
Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · no other runtime deps.

## Run

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # production build
pnpm start
```

## Email capture

`POST /api/waitlist` validates server-side (format, honeypot `company` field, in-memory rate limit 5/min/IP) and forwards to a provider adapter (`src/lib/waitlist.ts`), tried in order:

1. **Resend audience** — set `RESEND_API_KEY` + `RESEND_AUDIENCE_ID`
2. **Generic webhook** — set `WAITLIST_WEBHOOK_URL` (receives `{email, source}`)
3. **Dev fallback** — appends to `.waitlist/signups.jsonl` (non-production only)

In production with no provider configured, the API returns 502 — it never fakes success. Copy `.env.example` to `.env.local` and fill one option.

## Deploy (Vercel)

- Import the repo, set root directory to `site/`.
- Env vars: `NEXT_PUBLIC_SITE_URL` + one provider option above.
- Note: the in-memory rate limit is per-instance; good enough for a waitlist page.

## Design system

See `../DESIGN.md` (brand thesis, tokens, typography, forbidden patterns) and `../artifacts/landing-page/` for positioning, direction studies, page plan, copy, and QA report.
