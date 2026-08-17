# The Anti-Spin Read

The same news story, told differently by different outlets — read the difference.

Scrapes top news outlets (via Google News RSS — no fragile per-site scraping), detects when outlets are covering the *same story*, and uses Gemini to produce a **framing report**: how the headlines differ, tone by outlet, and what each outlet left out.

Everything runs on Cloudflare's free tier: a single Worker serves the API **and** the React SPA, stores data in D1 (SQLite), and schedules itself with a Cron Trigger. No other infrastructure.

## Architecture

```
Google News RSS (8 outlets)
        │  ┌─────────────┐  ┌──────────────┐  ┌────────────┐
        └─▶│  scraper.ts │─▶│ cluster.ts   │─▶│ framing.ts │  Gemini (free tier)
           └─────────────┘  └──────────────┘  └─────┬──────┘
        Worker Cron Trigger (every 15 min)          │
                          │                         │
                          ▼                         ▼
        ┌────────────────────────────────────────────────────┐
        │  Cloudflare Worker (Hono, backend/src/index.ts)     │
        │  · POST /api/cron      — manual pipeline trigger    │
        │  · GET  /api/clusters  — latest framed stories      │
        │  · GET  /              — React + Vite SPA (assets)  │
        └───────────────┬────────────────────────────────────┘
                        │ D1 binding (SQLite)
                        ▼
               Cloudflare D1 database
```

## Repository layout

- `backend/` — Cloudflare Worker (Hono + TypeScript): scraper, clustering, Gemini framing, D1 data layer, wrangler config, D1 migrations
- `frontend/` — React + Vite + Tailwind single-page app, built into the Worker's static assets

## Docs

- `docs/architecture.md` — high-level architecture: pipeline, read API, D1 data model, read/write separation
- `docs/api.md` — full API contract (request/response shapes, errors, headers, CORS)
- `docs/adr/0001-worker-monolith.md` — why one Worker serves API + SPA
- `docs/adr/0002-d1-sqlite.md` — why D1 is the store, and the retention/purge design
- `docs/adr/0003-structured-gemini-output.md` — why Gemini framing is schema-constrained JSON with a validation gate
- `AGENTS.md` — commands, migration workflow, security and architecture rules for coding agents
- `CHANGELOG.md` — release history (1.0.0: the hardening pass)

## Key design decisions

**Clustering (no paid API).** Headlines are tokenized (stopwords stripped); same-source near-duplicates are coalesced; stories match when their token sets share *rare* tokens. Composite score = Jaccard × (1 + 2 × rare-share), threshold 0.45. Clusters must span 2+ different outlets — same-outlet duplicates are deduped away, cross-outlet comparisons are the product.

**Google News RSS instead of scraping sites directly.** Stable, legal-surface-light, includes source attribution. Google News headline format (`Headline - BBC`) is stripped.

**Framing prompt.** Per cluster: headline deltas, per-outlet tone tags, notable omissions, neutral summary — strict JSON out, structural validation in.

**Story images.** Google News RSS carries no images, so after clustering the pipeline fetches each new-cluster article's page, extracts its `og:image`, and stores it in D1 (`articles.image_url`). Fetches follow up to 2 redirect hops (Google-News links and redirecting publishers) and re-check every hop against the SSRF guard; failed attempts are throttled by a retry gate so blocking publishers can't starve the queue. Best-effort only — the UI falls back to a striped letter-monogram placeholder, never a stretched favicon. Fetching only cluster articles keeps the Worker well under its 50-subrequest free-tier budget.

**Cloudflare everything.** D1 (SQLite) replaces MongoDB — the pipeline's "memory" so stories accumulate across runs and no story is framed twice. The Worker Cron Trigger replaces the GitHub Actions scheduler. One `wrangler deploy` ships DB schema, API, and SPA together.

**Failure-tolerant pipeline.** The pipeline holds a D1 single-row lock (15-min lease) so overlapping runs skip instead of colliding; clusters are deduplicated by a deterministic signature (`hash(sorted article keys)`), so re-runs never duplicate rows; framing failures are recorded on the cluster and retried on the next run (3 attempts, backoff, non-retryable 4xx fails fast).

**Security posture.** `POST /api/cron` is fail-closed: with no `CRON_SECRET` configured it returns 503 — there is no default secret. Compare is constant-time, and per-IP rate limiting (default 5 per 10 min, `CRON_RATE_LIMIT`) protects the trigger. Responses carry CSP + nosniff + X-Frame-Options + Referrer-Policy headers, CORS is an explicit allowlist (`ALLOWED_ORIGINS`), and every URL served from feed data (article URLs, og:images) passes an SSRF-safe `http(s)` check (private/reserved hosts rejected). Client-facing errors are generic — Gemini error details stay in D1 for the operator.

## Run locally

Prereqs: Node 20+, a Cloudflare account (for D1), Gemini API key.

```bash
# backend (API + SPA in one Worker via wrangler dev)
cd backend
npm install
cp .dev.vars.example .dev.vars          # fill GEMINI_API_KEY, CRON_SECRET
npx wrangler d1 create anti-spin-read   # once — copy database_id into wrangler.jsonc
npm run migrate:local                   # apply D1 migrations to the local DB
npm run dev                             # :8787 — serves API + built SPA

# frontend (separate terminal, for HMR)
cd frontend
npm install
npm run dev                             # :5173, proxies /api → :8787
```

Trigger a pipeline run: `curl -X POST http://localhost:8787/api/cron -H "x-cron-secret: dev-secret-change-me"`

Open http://localhost:5173 — stories appear within a minute. (Scheduled runs aren't automatic in `wrangler dev`; trigger one manually as above.)

## Deploy for free

1. **Create the database**: `cd backend && npx wrangler d1 create anti-spin-read` — paste the returned `database_id` into `backend/wrangler.jsonc`.
2. **Set secrets**: `npx wrangler secret put GEMINI_API_KEY` and `npx wrangler secret put CRON_SECRET`.
3. **Deploy**: `npm run deploy` — builds the frontend, applies D1 migrations, deploys the Worker.
4. **Done.** The Cron Trigger runs the pipeline every 15 minutes automatically (free tier). The API and SPA share one URL (e.g. `https://anti-spin-read.<subdomain>.workers.dev`).

Cost: $0. Cloudflare Workers free tier (100k requests/day) + D1 free tier (5 GB, 5M rows read/day) + Gemini free tier.

## API

| Route | Auth | Description |
|---|---|---|
| `GET /api/health` | none | liveness |
| `POST /api/cron` | `x-cron-secret` header | run scrape → dedupe → cluster → frame (manual trigger; the Cron Trigger is automatic) |
| `GET /api/clusters` | none | latest 50 framed stories, newest first (articles include `imageUrl`; each cluster carries a deterministic `category`: `politics` \| `world` \| `business` \| `tech` \| `science-health` \| `crime-justice` \| `culture-sport` \| `other`) |

## Tuning knobs

- `GEMINI_MODEL` — swap the framing model (wrangler var or `.dev.vars`)
- `CLUSTER_WINDOW_HOURS` — how far back articles cluster (48h)
- `CRON_RATE_LIMIT` — max manual `/api/cron` triggers per IP per 10 min (5)
- `ALLOWED_ORIGINS` — comma-separated CORS allowlist (defaults to local dev origins)
- `cluster.ts` constants — `THRESHOLD` (0.45), `NEAR_DUP_JACCARD` (0.7), `RARE_MAX` (5), `RARE_BOOST` (2), `CLUSTER_WINDOW` (8)
- `framing.ts` constants — `MAX_ATTEMPTS` (3), caps on deltas/omissions/tone tags
- `config.ts` `sources` — add/remove outlets (any domain works with Google News RSS)
- Secrets (`GEMINI_API_KEY`, `CRON_SECRET`) — `npx wrangler secret put …`

## Tests

```bash
cd backend
npm run typecheck      # strict TS, noUnusedLocals, src + scripts
npm test               # offline units: cluster, framing, categorize, images, D1 data layer, pipeline
npm run test:api       # API integration (in-memory Db; 401/503/429, headers, sanitization; hits live RSS)
npm run test:e2e       # full pipeline + idempotency (in-memory Db; hits live RSS)
npm run eval:framing   # framing evaluator: offline corpus + optional live Gemini (--live)

cd frontend
npm test               # vitest + testing-library component tests
```

UI smoke test (seeded data, no keys needed): `npm run seed:ui` in `backend` (port 4321), then `VITE_API_BASE=http://localhost:4321 npm run dev` in `frontend`, then `python frontend/tests/ui_test.py` (desktop + mobile pass, zero console errors).

CI (`.github/workflows/ci.yml`) runs the backend typecheck + offline tests and the frontend lint + vitest + build on every push.
