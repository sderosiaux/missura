# Semantic Access Proxy — landing page

Waitlist landing page for Missura (Semantic Access Proxy) (see `../spec.md`).
Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · no other runtime deps.

## Run

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # static export → out/
```

The site is a static export (`output: "export"` in `next.config.ts`). There is no
server, no API route, no runtime environment: every `NEXT_PUBLIC_*` value is baked
in at build time.

## Email capture

The form POSTs JSON `{email, source}` to `NEXT_PUBLIC_WAITLIST_ENDPOINT` — any
endpoint accepting that payload (provider form endpoint, Zapier/Make webhook, or
a small worker). Client-side it checks the email format and drops submissions
that fill the hidden `company` honeypot.

When `NEXT_PUBLIC_WAITLIST_ENDPOINT` is unset at build time, the form is not
rendered at all: the section shows the note "Waitlist opens soon — the endpoint
isn't wired yet." No fake success, ever.

Validation that must be trusted (rate limiting, dedup, abuse filtering, storage)
belongs to the endpoint — the static site cannot enforce any of it.

Copy `.env.example` to `.env.local` and fill the endpoint to test locally.

## Deploy

Built and published by `.github/workflows/pages.yml` (GitHub Pages). Build-time
env: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_BASE_PATH` (`/missura` for the project
page, empty for a custom domain), `NEXT_PUBLIC_WAITLIST_ENDPOINT`.

## Design system

See `../DESIGN.md` (brand thesis, tokens, typography, forbidden patterns) and `../artifacts/landing-page/` for positioning, direction studies, page plan, copy, and QA report.
