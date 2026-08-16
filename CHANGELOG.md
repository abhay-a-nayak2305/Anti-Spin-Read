# Changelog

All notable changes to The Anti-Spin Read are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Unbounded pipeline run log** — `pipeline_runs` kept one row per 15-min
  run forever (~35k rows/year). The daily retention purge now also drops
  run-log rows older than 90 days (`RUNS_RETENTION_DAYS`), so every table
  in D1 is bounded: 14 days for clusters/articles, 90 days for the log.
- **Pipeline hard-kill on production (`exceededResources`)** — scheduled runs
  were being killed by the platform mid-scrape (after the feed batch, ~20 ms
  CPU, no run row, no lock release). Root cause: up to 8 feed fetches fired in
  parallel against Cloudflare's per-request outbound-connection limits, with a
  4 MB per-feed body cap letting oversized feeds hold connections open. The
  scraper now fetches feeds in bounded batches of 4 (`SCRAPE_BATCH`) and caps
  each feed at 2 MB (`MAX_FEED_BYTES`), keeping in-flight connections within
  platform limits. Verified: 10+ consecutive full runs (scrape → dedup →
  cluster → frame → maintain) complete every 15 minutes.
- **Framing stuck failing on retired Gemini models** — `gemini-2.0-flash` was
  retired ("no longer available to new users"); `frameCluster` treated a 404 as
  a non-retryable failure and never tried the fallback model, so every cluster
  recorded `framing_error` on every run. Two changes: model-not-found 404s now
  switch to the fallback model (matching the documented fallback semantics),
  and the model defaults moved to currently-available models —
  `GEMINI_MODEL` `gemini-3.5-flash` (stable), `GEMINI_MODEL_FALLBACK`
  `gemini-3.1-flash-lite`.

### Changed

- **Scraper feed budget** — `MAX_FEED_BYTES` 4 MB → 2 MB; feed fetch loop
  bounded to `SCRAPE_BATCH = 4` concurrent fetches.
- **More outlets (8 → 18)** — added France 24, DW, Sky News, CNBC, The Verge,
  ABC News, NBC News, USA Today, The Independent and Politico to `sources`
  (with direct RSS endpoints, suffix stripping and test stubs). More outlets →
  more cross-outlet story overlap, so clustering produces more stories across
  more categories (world/business/tech in particular).
- **Frontend tone + status colors** — the framing status stamp is now
  green for `FRAMED` (alarm-red for `FAILED`, dashed for `PENDING`) instead of
  the generic acid-yellow stamp, and each tone has its own color
  (`celebratory` green, `analytical` cyan, `urgent` orange, `skeptical`
  purple, `alarmist` red, `neutral` plain) instead of sharing yellow/white.
- **Frontend card cleanup** — the `FRAMED`/`FAILED`/`PENDING` status badge is
  removed from the story cards **and the story modal** (the modal header now
  shows category + count + time only).
- **Frontend modal theme colors** — structural elements in the story modal now
  take the story's **category color** instead of the acid accent: section
  header stamps (`How the coverage differs`, `Tone by outlet`, `The news,
  outlet by outlet`) and `READ FULL ARTICLE →` buttons use the category fill
  (e.g. purple for Culture & Sport, red for Crime & Justice); the `The story`
  summary box is a category-colored slab with an ink offset shadow.
- **Frontend "new since your last visit"** — a persisted watermark (newest
  acknowledged `seenAt`, stored in `localStorage`) badges stories that
  appeared since the previous visit with a `NEW` stamp on the card and an
  acid "N new stories — click to mark read" chip above the filters. The
  watermark advances only on manual refresh, so stories that arrive while
  the page is open stay badged until the user acknowledges them; a
  first-ever visit shows no banner.

## [1.0.0] - 2026-08-15

First release: the full hardening pass. One Cloudflare Worker (Hono) serves the
React SPA and the read API from a single deployable; D1 (SQLite) is the only
store; a cron trigger runs the scrape → dedup → cluster → frame → maintain
pipeline every 15 minutes.

### Added

- **Real-SQLite D1 test harness** (`backend/scripts/sqlite-d1.ts` + `test-db-d1.ts`): the actual migrations applied to an in-memory `better-sqlite3` database, so SQL syntax errors, ambiguous columns, and JOIN mistakes fail loudly instead of being emulated away — 44 assertions across 12 groups.
- **Migration 0004 (meta table)** — key/value maintenance state (`last_purge_ms`, future job markers) with upsert.
- **Migration 0005 (pipeline_runs event log)** — one row per pipeline execution (success or failure) for operator health checks without log scraping.
- **`GET /api/runs`** — ops endpoint: recent pipeline runs from the event log, newest first, `no-store`.
- **`GET /api/clusters` pagination** — `limit` (1–50, default 50) and `offset` (0–10000, default 0) with strict validation (400 on anything non-numeric or out of range) and a `hasMore` flag.
- **Request-ID + structured JSON logs** — every request gets an 8-hex `X-Request-Id`; every request/error is logged as JSON (path only, never the raw query string).
- **`X-RateLimit-Limit` / `X-RateLimit-Remaining` / `Retry-After` headers** on `POST /api/cron` (per-IP sliding window).
- **Workers Cache API edge caching for `/api/clusters`** — 60s, keyed on the full URL, with `Cache-Control: public, max-age=60`.
- **Gemini `responseSchema` constrained output** — `responseMimeType: application/json` + a structural schema for the framing report.
- **`GEMINI_MODEL_FALLBACK`** — a secondary model (default `gemini-1.5-flash`) tried with 2 attempts when the primary exhausts its 3 retries (outage, quota, deprecation).
- **Unicode/CJK clustering** — `tokenize()` is Unicode-aware (`\p{L}\p{N}`) and expands CJK runs into overlapping character bigrams so differently-worded Chinese/Japanese/Korean headlines still share signal.
- **Eval harnesses** — `scripts/eval-framing.ts` (offline corpus of realistic Gemini outputs: fenced, prose-wrapped, malformed tones, caps; live mode with `--live`/`GEMINI_API_KEY`) and `scripts/eval-cluster.ts` (bilingual EN/AR/ZH labeled corpus with precision ≥ 0.8, recall ≥ 0.7, decoy checks).
- **CI workflow** (`.github/workflows/ci.yml`) — backend typecheck + tests, frontend lint + vitest + build, framing-eval gate, cluster-eval gate, npm audit (both packages, `--audit-level=high`), and a live pipeline e2e on `main` only.
- **Deploy workflow** (`.github/workflows/deploy.yml`) — build frontend → apply D1 migrations remotely → `wrangler deploy`, gated on `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets.
- **Dependabot config** (`.github/dependabot.yml`) — weekly npm updates for `backend/` and `frontend/` with grouped PRs (cloudflare, hono, vite, react), monthly GitHub Actions updates.
- **Frontend** — "Load more" pagination (append + dedupe by cluster id, superseding fetch, exponential backoff 1s→60s, polling paused while the tab is hidden); privacy-friendly outlet favicons served from each site's own origin (`<host>/favicon.ico`) instead of Google's `s2` favicon service; CLS fixes (image wrappers own the 16:9 aspect ratio, explicit `loading`/`decoding`, `NO IMAGE` block inside an `aspect-video` container).

### Changed

- **Scraper rewrite** (`backend/src/scraper.ts`) — explicit 15s fetch timeout (AbortController), content-type validation (an HTML error page is rejected as a feed), 4MB body cap, 200-item per-feed cap, outlet-suffix stripping that now handles the trailing-ellipsis forms (`"… The Hill"`, `"… Reuters"`) and the AP News/Associated Press variants, and entity decoding done in the correct order (raw `content:encoded` preferred because `contentSnippet` destroys escaped entities).
- **`tokenize()` is Unicode-aware** — non-`\p{L}\p{N}` characters stripped, CJK bigram expansion (see Added).
- **`Db.latestClusters(limit, offset)`** — two-query read (clusters first with LIMIT/OFFSET, then articles in one chunked `IN` query) so the cluster straddling the page boundary never gets truncated.
- **Rate limiter returns remaining quota** — `AllowResult { allowed, remaining, retryAfterMs }` surfaced as `X-RateLimit-*` / `Retry-After` headers.

### Fixed

- **Immutable-ASSETS-headers 500** — `ASSETS.fetch` responses carry frozen headers; the SPA fallback and 404 paths now copy into a mutable `Response` so the security-header middleware (CSP/nosniff/XFO/Referrer-Policy) can be applied.
- **Ambiguous `dedup_key` SQL columns** — the article-join queries now qualify every column (`ca.dedup_key`, `a.dedup_key`, …) after the ambiguous-column JOIN bug shipped.
- **`"… The Hill"` suffix leaks** — outlet suffixes at the end of ledes/titles surrounded by ellipses or dashes are now stripped.
- **RSS entity destruction in `contentSnippet`** — rss-parser decodes entities before stripping tags, so escaped angle brackets (`&lt;no&gt;`) in snippets were destroyed; the scraper now prefers raw `content:encoded` and runs `stripHtml` (tags first, then entities).
- **FQDN trailing-dot SSRF bypass** — `isSafeHttpUrl` strips a trailing dot (`db.internal.`) before any host checks.
- **Encoded IPv4 SSRF vectors** — `inet_aton`-compatible parsing covers decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), and short forms (`127.1`); ambiguous octal digits 8/9 fail closed.
- **CGNAT / benchmarking / test-net ranges** — `isReservedIpv4` now also blocks 100.64.0.0/10 (CGNAT), 198.18.0.0/15 (benchmarking), and the TEST-NET blocks (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), plus IPv6 equivalents (ULA `fc00::/7`, link-local, `2001:db8::/32`, multicast, IPv4-mapped forms).

### Security

- **Tightened CSP** — `connect-src 'self'` added (was unset); full policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
- **SSRF hardening** — `isSafeHttpUrl` (backend/src/images.ts) rejects private/reserved IPv4 in any encoding, reserved IPv6 literals (including `::ffff:` IPv4-mapped), trailing-dot FQDNs, and reserved TLD suffixes (`.local`, `.internal`, `.localhost`, `.test`, `.invalid`, `.home.arpa`). Applied at fetch time (og:image enrichment, redirect-chain re-check) and at serve time (article/image URLs in `/api/clusters` responses are re-checked and replaced with `""` when unsafe).

[Unreleased]: https://github.com/anti-spin-read/anti-spin-read/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/anti-spin-read/anti-spin-read/releases/tag/v1.0.0