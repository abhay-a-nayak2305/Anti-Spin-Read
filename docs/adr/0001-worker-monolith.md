# ADR 0001 — Single Worker monolith (API + SPA)

- **Status:** Accepted
- **Date:** 2026-08-15 (hardening pass, shipped as 1.0.0)
- **Deciders:** backend + frontend + docs (single-team project)

## Context

The Anti-Spin Read needs to serve two things on the public internet: a JSON
API (`/api/*`) and a React single-page app. It runs on Cloudflare's free tier
with a $0 budget and one domain. The alternatives considered were:

1. **Separate API Worker + static assets host** — a dedicated API Worker and
   the SPA on Cloudflare Pages, two deployables, two URLs.
2. **Single Worker serving both** (chosen) — one Hono app handles `/api/*`,
   everything else falls through to the `ASSETS` binding (`run_worker_first:
   true`) which serves the built `frontend/dist`.

## Decision

Ship one Worker (`backend/src/index.ts`) that serves the API **and** the SPA
from a single deployable. The Worker owns every request; `/api/*` is handled
by Hono routes; anything else is delegated to `ASSETS.fetch()` (the SPA), with
`/api/*` misses staying JSON 404s. The frontend build is part of the deploy:
`npm run deploy` builds `frontend/dist` first, then `wrangler deploy` ships
schema, API, and SPA together.

## Why

- **Free tier, one account, one domain.** One Workers free-tier allocation
  (100k requests/day) and one `*.workers.dev` URL. No Pages project, no
  separate domain or CORS surface for the SPA.
- **Atomic deploys.** The SPA and the API cannot drift: one version tag ships
  both. `frontend/dist` is committed to the deploy by construction (the
  deploy workflow builds it in the same job).
- **Same-origin by default.** Production serves SPA and API from one origin,
  so CORS rarely matters there (`ALLOWED_ORIGINS` exists for the dev
  :5173→:8787 split and future cross-origin consumers).
- **Edge caching for reads.** The one thing that would otherwise argue for
  scaling the read path separately — D1 read amplification on `/api/clusters`
  — is handled by the Workers Cache API (60s TTL), not by more replicas.

## Consequences / tradeoffs

- **No separate API scaling.** The pipeline (scraping 8 RSS feeds, Gemini
  calls, image enrichment) and the read API share one isolate pool and one
  CPU/memory budget. This is acceptable because the pipeline is cron-driven
  (15 min cadence), bounded (feed/body caps, 30-article enrichment cap,
  concurrency 3/5), and the read path is edge-cached.
- **The Worker must be a good citizen in both roles.** Free-tier subrequest
  budget (50/invocation) constrained the og:image enrichment design; the SPA
  must be buildable into static assets the Worker can serve without server
  rendering.
- **SPA responses need mutable headers.** `ASSETS.fetch` returns immutable
  `Headers`, which broke the security-header middleware (the immutable-headers
  500 bug). Responses are copied into mutable `Response` objects so CSP /
  nosniff / X-Frame-Options / Referrer-Policy can be applied uniformly.
- **Single blast radius.** One bad deploy takes down API and UI together —
  mitigated by the CI gates (typecheck, tests, evals) and the deploy workflow
  running only on `main`.

## Alternatives considered and rejected

- **Separate Pages + Worker:** two deployables to keep in sync, two URLs,
  SPA assets fetched cross-origin — more CORS surface, no atomic deploys, no
  benefit at this scale.
- **API gateway / framework router splitting:** still one deployable; Hono's
  `app.notFound` fallback already gives the same behavior with less ceremony.