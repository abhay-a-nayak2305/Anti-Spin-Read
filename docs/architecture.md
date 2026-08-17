# Architecture — The Anti-Spin Read

## At a glance

The Anti-Spin Read is a media-framing comparison service. It detects when
multiple news outlets are covering the same story, asks Gemini to analyze how
each outlet *frames* it (headline deltas, tone, notable omissions, neutral
summary), and serves the results as a single-page app.

Everything runs on Cloudflare's free tier:

- **One Worker** (Hono, TypeScript) serves the JSON API **and** the built React
  SPA from a single deployable (`backend/src/index.ts`, `assets` binding with
  `run_worker_first: true`).
- **D1** (SQLite) is the *only* store — articles, clusters, framing JSON, the
  pipeline lock, maintenance state, and the pipeline event log.
- A **cron trigger** (`*/15 * * * *`) runs the pipeline automatically; no
  external scheduler. A second trigger (`FRAMING_CRON_SCHEDULE` in
  `backend/src/config.ts`, `7,22,37,52 * * * *`) runs the same pipeline in
  **framing-only mode**: it skips scrape/dedup/enrich and frames only the
  retry queue (up to 14 clusters per run — 14 × 3 worst-case Gemini
  attempts = 42 subrequests < 50), so an unframed backlog can never linger.
  The `scheduled` handler dispatches on the exact schedule string
  (`controller.cron === FRAMING_CRON_SCHEDULE`); the two strings must stay
  in sync.
- Workers are **stateless** — all durable state lives in D1 (the rate limiter
  is per-isolate in-memory by design; see below).

```
┌─────────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (single deployable, backend/src/index.ts)        │
│                                                                     │
│  Cron */15 * * * * ──▶ scheduled handler ──▶ runPipeline            │
│  Cron 7,22,37,52 * * ─▶ scheduled handler ──▶ runPipeline(framingOnly)│
│        │                                                            │
│        ▼                                                            │
│  runPipeline (backend/src/pipeline.ts)                              │
│    1. scrape: direct outlet RSS, 18 outlets (scraper.ts)              │
│        · 15s timeout · content-type/4MB caps · suffix stripping     │
│    2. dedup + insert: articles (dedup_key PK, INSERT OR IGNORE)     │
│    3. cluster: new articles vs recent unclustered pool (48h, window 128)│
│        · Unicode-aware, CJK bigram expansion (cluster.ts)           │
│    4. enrich: og:image per new-cluster article (images.ts)          │
│        · SSRF-safe fetches, best-effort, retried next run           │
│    5. frame: Gemini with responseSchema + model fallback            │
│        · framing JSON validated by normalizeFraming (framing-schema)│
│        · failures recorded, retried from queue (3+2 attempts)       │
│        · framing-only runs: steps 1-4 skipped, queue-only, 14 max   │
│        · idle guard: empty queue → one read, no lock/run-log writes │
│    6. maintain: 14-day retention purge (+90d run log), ≤ once per 24h   │
│        · gated by meta.last_purge_ms (migration 0004)               │
│    7. record: pipeline_runs event log row (migration 0005)          │
│                                                                     │
│  Read API (Hono routes)                                             │
│    GET  /api/health      liveness                                  │
│    GET  /api/clusters    paginated, edge-cached 60s                │
│    POST /api/cron        manual trigger (secret + rate limit)      │
│    GET  /*               SPA from ASSETS (run_worker_first)        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ D1 binding (SQLite)
                               ▼
                       Cloudflare D1 database
```

## The pipeline (`backend/src/pipeline.ts`)

One full run: `scrape → dedup/insert → cluster → enrich → frame → maintain → log`.

1. **Scrape.** `scrapeAll(windowHours)` fetches Google News RSS filtered per
   outlet (`when:{hours}h site:{site}`) for the 18 configured outlets
   (`config.ts`). Each feed is validated (15s timeout, non-HTML content-type,
   4MB body cap, 200-item cap). Titles/ledes are cleaned: Google's
   `"Headline - BBC"` suffix, outlet-name variants (`AP News`, `Al Jazeera
   English`, `… The Hill`), and HTML entities are stripped. Articles get a
   deterministic `dedupKey = source|hash(normalized title)`.
2. **Dedup + insert.** Only articles not already stored are inserted
   (`INSERT OR IGNORE`, primary key `dedup_key`). `insertArticles` returns the
   *new* rows — everything downstream only sees new material.
3. **Cluster.** The input pool is the run's new articles **plus every recent
   unclustered article** in the clustering window (`CLUSTER_WINDOW_HOURS`, via
   `recentUnclusteredArticles` — the `NOT EXISTS` cluster reference check).
   Direct RSS feeds only surface each outlet's latest items, so the second
   outlet covering a story often arrives runs/hours after the first; matching
   against the pool catches those stories, and once a cluster is created its
   articles leave the pool (sig uniqueness + the `clusterExistsWithFraming`
   guard prevent re-creation). `clusterArticles` tokenizes titles
   (Unicode-aware; CJK runs expand to overlapping bigrams), coalesces
   same-source near-duplicates (Jaccard ≥ 0.7), and greedily groups stories
   with a composite score: `Jaccard × (1 + 2 × rare-share)` above threshold
   0.45, against a sliding window of the 128 most recent clusters (the pool
   is ~10x a single run's batch; the default 8 stays for the eval corpus).
   Only clusters spanning **2+ different outlets** survive. Clusters are
   keyed by a deterministic signature (`hash(sorted article keys)`) with a
   unique index, so re-runs return the existing cluster instead of
   duplicating rows.
4. **Enrich.** Articles without an image get one from, in order of
   preference:
   - **Feed-carried images** (`extractFeedImage` in `scraper.ts`): the
     `<img>` Google News embeds in item descriptions (CDATA, entity-decoded)
     or `<media:content>`/`<enclosure url>` from direct feeds (The Hill, Sky
     News, …). Feed-supplied URLs are untrusted input and pass
     `isSafeHttpUrl` before they're stored.
   - **og:image** (`images.ts`): the page is fetched (6s timeout, HTML-only,
     `HTMLRewriter` in Workers / regex fallback in Node) and `og:image`
     extracted — never following non-http(s) schemes, always passing
     `isSafeHttpUrl`. Sent with a browser-like UA: several outlets 403
     non-browser UAs. Best-effort: failures are skipped and retried next
     run (per-run `ENRICH_BATCH=8` for fresh clusters plus a 4-article
     catch-up for older image-less cluster articles, all inside the
     free-tier subrequest budget).
5. **Frame.** Up to 3 concurrent Gemini calls per cluster with `responseSchema`
   constrained JSON output (`temperature 0.4`, `maxOutputTokens 1200`). The
   primary model gets 3 attempts with backoff (500/1500 ms); transient failures
   (429, 5xx, network, parse) retry, non-retryable 4xx fail fast. When the
   primary is exhausted, `GEMINI_MODEL_FALLBACK` gets 2 attempts before giving
   up. Output is validated by `normalizeFraming` **at rest**: the same
   structural rules that accept model output also gate what's persisted and
   what's served back from D1, so a corrupted row can never surface as valid
content. Failures record a sanitized `framing_error` on the cluster and the
    cluster joins the retry queue (`clustersNeedingFraming`, oldest first,
    batch of 50) for the next run.
    **Framing-only mode** (second cron trigger) skips steps 1–4 entirely, so
    the whole free-tier subrequest budget goes to Gemini:
    `FRAMING_ONLY_BATCH = 14` × 3 worst-case attempts = 42 < 50 (≥8 headroom).
    Normal runs cap at `FRAMING_BATCH = 3` (new clusters first) so the burst
    never exhausts the 50-subrequest budget; the framing cron drains the
    leftover retry queue every 15 minutes. When the queue is empty the run
    bails after a single `clustersNeedingFraming(1)` read — before the lock —
    and records nothing, so an idle framing cron costs ~1 read per run.
6. **Maintain.** Retention purge: clusters older than 14 days are deleted
   (cascading `cluster_articles` via FK), articles older than the cutoff
   that are no longer referenced by any cluster are removed as orphans, and
   `pipeline_runs` rows older than 90 days are dropped (the run log has its
   own longer retention so it stays bounded too). Executed at most once per
   24h, gated by `meta.last_purge_ms` (migration 0004) — maintenance is
   rate-limited by the meta table, not by clock time.
7. **Record.** One row per run (success *or* failure) is appended to
   `pipeline_runs` (migration 0005). No read API exposes it — the nightly
   `check-pipeline-health.ts` job reads the log directly via
   `wrangler d1 execute`.

### Pipeline lock

A single-row D1 table (`pipeline_lock`, `id = 1`) serializes runs. Acquire is
`INSERT OR IGNORE`; if the row exists and the 15-minute lease has expired, the
lock is stolen with a conditional `UPDATE` (`WHERE acquired_at < now - 15min`).
Release is `DELETE ... WHERE token = ?` — only the owning run (matching token)
can release. Overlapping runs (cron + manual trigger) skip instead of
colliding, and the skip itself is recorded in the event log (`skipped: 1`).

**Watchdog.** Each run additionally races a 12-minute timer (`WATCHDOG_MS` in
`pipeline.ts`, injectable for tests). If the timer wins, the run records
`pipeline watchdog: stuck in stage "X"` in the event log — stage markers are
updated at every phase (scrape → insert-articles → cluster → enrich →
queue-clusters → frame → maintain) so the error pinpoints the hang — and the
`finally` block releases the lock. This bounds the damage of any stuck
outbound call (a fetch whose abort never fires, a D1 write stall, …): the
worst case is one skipped 15-minute slot, never a zombie that blocks later
runs.

**Lease backstop (platform-frozen zombies).** If the platform freezes or
evicts the isolate itself, no timer can fire and no `finally` runs — the
watchdog is dead, and the lock row outlives its owner. The 15-minute lease is
the backstop: the next cron slot's acquire sees the expired lease and steals
it, so even a fully frozen invocation can block the pipeline for at most
~15 minutes (observed Aug 17 2026: two consecutive zombies at 12:45Z and
13:15Z held a 30-min lease; recovery came only when the lease expired and
13:45Z stole it). 15 min > 12-min watchdog > worst-case healthy run
(~11.25 min framing-only), so no legitimate run is ever stolen.

## The read API (`backend/src/index.ts`)

- **`GET /api/clusters`** — paginated (`limit` 1–50 default 50, `offset`
  0–10000 default 0, strict validation → 400), newest framed-first, with
  `hasMore`. **Edge-cached** via the Workers Cache API (60s, keyed on the full
  URL, `Cache-Control: public, max-age=60`) — cached bodies are copied into a
  mutable Response so security headers and per-origin CORS are re-applied.
  Served URLs and image URLs pass `isSafeHttpUrl` again at serve time.
- **`GET /api/search?q=&limit=`** — case-insensitive substring search over
  cluster key phrases, article titles, and ledes via plain SQLite `LIKE`
  (metacharacters escaped, so user input can't widen the match). No FTS5:
  the table is ~100 clusters, sub-ms scans, and it stays free-tier friendly.
  Edge-cached 60s like `/api/clusters`.
- **`GET /api/clusters/:id`** — single story for shareable `#/story/<id>`
  deep links; 404 (uncached) when the story was purged by the 14-day
  retention.
- **`GET /story/:id`** — server-rendered OG/Twitter/JSON-LD share page so
  crawlers and link previewers get markup without JS. All feed text is
  HTML-escaped and the JSON-LD blob escapes `<`/`>` (a feed title containing
  `</script>` cannot break out). Missing stories → 404 noindex page so
  crawlers drop stale links. Edge-cached 1h.
- **`GET /robots.txt` + `GET /sitemap.xml`** — crawler rules (disallow
  `/api/`) and up to 10 000 story URLs (`/story/<id>`, `lastmod` = seen
  date), both escaped, sitemap edge-cached 6h. Zero config on search
  engines' side: the sitemap URL is emitted with the request's own origin.
- **`POST /api/cron`** — manual pipeline trigger. Fail-closed secret auth
  (constant-time compare, 503 when `CRON_SECRET` is unset), per-IP sliding
  window rate limit (default 5 per 10 min) with `X-RateLimit-*` /
  `Retry-After` headers.
- **`GET /api/health`** — liveness for uptime monitors.
- **`GET /*`** — the built SPA via the ASSETS binding (`run_worker_first`),
  with a mutable-response copy so security headers apply; the SPA shell is
  served with `Cache-Control: no-cache` (deploys change it). `/api/*` misses
  stay JSON 404s.

Every response carries `X-Request-Id` (8-hex, correlated in structured JSON
logs), CSP / nosniff / X-Frame-Options: DENY / Referrer-Policy: no-referrer,
and per-origin CORS headers only for origins in the `ALLOWED_ORIGINS`
allowlist (defaults to local dev origins).

## Data model (D1)

| Table | Purpose | Key migration |
|---|---|---|
| `articles` | deduped feed articles (`dedup_key` PK, epoch-ms timestamps) | 0001, 0002 (`image_url`) |
| `clusters` | one story ≥2 outlets; `sig` unique for idempotency; `framing` JSON; `framing_error` | 0001, 0003 |
| `cluster_articles` | cluster↔article join (FK cascade on cluster delete) | 0001 |
| `pipeline_lock` | single-row run lock with 15-min lease | 0003 |
| `meta` | key/value maintenance state (`last_purge_ms`, future job markers) | 0004 |
| `pipeline_runs` | event log, one row per pipeline execution | 0005 |

Framing is stored as a JSON column and validated structurally **on write and
on read** (`parseFraming` skips corrupt rows at query time — never served).

## Read/write separation

- **D1 is the only store.** No KV, no R2, no Durable Objects, no external
  database. Workers are stateless: any isolate can serve any request, and a
  deploy replaces the whole app atomically.
- The **write path** is the pipeline (cron or manual trigger); it holds the
  D1 lock, batches inserts at 100 statements, and chunks `IN` queries at 90
  bound params (D1's limit is 100).
- The **read path** is the API; D1 read amplification (repeat page views,
  other-isolate hits) is mitigated by the 60s edge cache on `/api/clusters`.
- The one piece of per-isolate state is the **in-memory sliding-window rate
  limiter** for `/api/cron` — fine for a single Worker instance; Cloudflare's
  Rate Limiting rules are the documented upgrade path if multi-isolate
  precision is ever needed.

## Observability

- **Structured JSON logs** — every request and every error logs a JSON line
  (level, ts, requestId, ip, method, path, status, ms); paths only, never raw
  query strings (URLs in query params can carry sensitive fragments).
- **Pipeline event log in D1** (`pipeline_runs`) — success and failure rows,
  read directly by the nightly `check-pipeline-health.ts` job (no read API
  route); `recordRun` failures are logged and never crash the pipeline.
- **Retention** — 14 days of clusters/articles in D1, 90 days of
  `pipeline_runs`; every table is bounded (free tier: 5M rows read/day, 1M
  writes/day — a row per 15 minutes is negligible).

## Automated checks

- **CI** (`.github/workflows/ci.yml`) — typecheck + full test suites on both
  packages, both offline eval gates, npm audit, and a live pipeline e2e on
  `main` only.
- **Nightly regression** (`.github/workflows/nightly.yml`, 03:17 UTC +
  manual dispatch) — re-runs both offline eval gates plus:
  - a **live feed health check** (`backend/scripts/check-feeds.ts`): scrapes
    all 18 outlets and fails when fewer than 10 respond, catching silent
    feed-URL changes or IP blocks that no offline test could. No secrets or
    Gemini keys involved.
  - a **live pipeline health check** (`backend/scripts/check-pipeline-health.ts`):
    reads D1 directly with `wrangler d1 execute` and fails when the newest
    run is older than 60 minutes, ≥3 consecutive runs were skipped (zombie
    lock), or the framing backlog exceeds 60 — the incident alarm for the
    platform-freeze class of failure, running on the same cron cadence as the
    pipeline itself. Needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
    (already used by the deploy workflow).

## Related docs

- `docs/api.md` — the full HTTP contract (request/response shapes, errors,
  headers, CORS).
- `docs/adr/0001-worker-monolith.md` — why one Worker serves API + SPA.
- `docs/adr/0002-d1-sqlite.md` — why D1 is the store and how it's tested.
- `docs/adr/0003-structured-gemini-output.md` — why framing is schema-constrained
  JSON with a validation gate.
- `AGENTS.md` — commands, migration workflow, security and architecture rules.
- `CHANGELOG.md` — release history (1.0.0 hardening pass).