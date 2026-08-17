<div align="center">

# The Anti-Spin Read

**The same news story, told differently by different outlets — read the difference.**

[![Build Status](https://img.shields.io/github/actions/workflow/status/abhay-a-nayak2305/Anti-Spin-Read/ci.yml?style=flat-square&label=CI)](https://github.com/abhay-a-nayak2305/Anti-Spin-Read/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-FF6700?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![D1](https://img.shields.io/badge/D1-SQLite-00599C?style=flat-square&logo=sqlite&logoColor=white)](https://developers.cloudflare.com/d1)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[Overview](#overview) • [Quick start](#quick-start) • [Deploy](#deploy) • [API](#api) • [Docs](#docs) • [Tests](#tests)

</div>

## Overview

Scrapes top news outlets via Google News RSS, detects when outlets are covering the *same story*, and uses Gemini to produce a **framing report**: how the headlines differ, tone by outlet, and what each outlet left out.

Everything runs on Cloudflare's free tier: a single Worker serves the API **and** the React SPA, stores data in D1 (SQLite), and schedules itself with a Cron Trigger. No other infrastructure.

```
Google News RSS (18 outlets)
         │
         ▼
   scraper.ts ──▶ cluster.ts ──▶ framing.ts ──▶ Gemini
                                                   │
              ┌────────────────────────────────────┘
              ▼
       Cloudflare Worker (Hono)
       · POST /api/cron   — manual pipeline trigger
       · GET  /api/clusters — latest framed stories
       · GET  /            — React SPA
                                                   │
                                                   ▼
                                          Cloudflare D1
```

> [!TIP]
> Story images are fetched post-clustering: each new article's `og:image` is extracted (with bounded redirect-following and SSRF checks) and cached in D1. The UI falls back to a letter monogram when no image is available.

## Quick start

Prereqs: Node 20+, a Cloudflare account, and a Gemini API key.

```bash
# backend (API + SPA in one Worker via wrangler dev)
cd backend
npm install
cp .dev.vars.example .dev.vars          # fill GEMINI_API_KEY, CRON_SECRET
npx wrangler d1 create anti-spin-read   # once — paste database_id into wrangler.jsonc
npm run migrate:local                   # apply D1 migrations
npm run dev                             # :8787 — API + built SPA

# frontend (separate terminal, for HMR)
cd frontend
npm install
npm run dev                             # :5173, proxies /api → :8787
```

Trigger a run: `curl -X POST http://localhost:8787/api/cron -H "x-cron-secret: dev-secret-change-me"`

Open http://localhost:5173 — stories appear within a minute. Scheduled runs aren't automatic in `wrangler dev`; trigger one manually as above.

## Deploy

1. **Create the database**: `cd backend && npx wrangler d1 create anti-spin-read` — paste the returned `database_id` into `backend/wrangler.jsonc`.
2. **Set secrets**: `npx wrangler secret put GEMINI_API_KEY` and `npx wrangler secret put CRON_SECRET`.
3. **Deploy**: `npm run deploy` — builds the frontend, deploys the Worker. Migrations apply automatically via the deploy workflow.
4. **Done.** Cron Trigger runs the pipeline every 15 minutes. The API and SPA share one URL (e.g. `https://anti-spin-read.<subdomain>.workers.dev`).

Cost: **$0**. Cloudflare Workers free tier (100k req/day) + D1 free tier (5 GB, 5M rows/day) + Gemini free tier.

## API

| Route | Auth | Description |
|---|---|---|
| `GET /api/health` | none | liveness |
| `POST /api/cron` | `x-cron-secret` header | run pipeline (manual trigger; Cron Trigger is automatic) |
| `GET /api/clusters` | none | latest 50 framed stories, newest first |
| `GET /api/clusters/:id` | none | single story (shareable deep links) |
| `GET /api/search?q=` | none | case-insensitive search over headlines and ledes |
| `GET /story/:id` | none | server-rendered OG/Twitter share page |

All responses carry `Cache-Control`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer` headers.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — pipeline, read API, D1 data model, subrequest budgeting
- [`docs/api.md`](docs/api.md) — full API contract (request/response shapes, errors, caching)
- [`docs/adr/`](docs/adr/) — architecture decision records (monolith, D1, structured Gemini output)
- [`AGENTS.md`](AGENTS.md) — commands, migration workflow, security and architecture rules for coding agents
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## Tests

```bash
cd backend
npm run typecheck      # strict TS, noUnusedLocals, src + scripts
npm test               # 8 offline suites: cluster, framing, categorize, images, D1 data layer, pipeline, API
npm run test:e2e       # full pipeline + idempotency (hits live RSS)
npm run eval:framing   # framing evaluator: offline corpus + optional live Gemini (--live)

cd frontend
npm test               # vitest + testing-library
```

UI smoke test: `npm run seed:ui` in `backend` (port 4321), then `VITE_API_BASE=http://localhost:4321 npm run dev` in `frontend`, then `python frontend/tests/ui_test.py` (desktop + mobile pass, zero console errors).
