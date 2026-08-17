# Changelog

All notable changes to The Anti-Spin Read are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Framing-only cron mode.** A second cron trigger (`7,22,37,52 * * * *`,
  `FRAMING_CRON_SCHEDULE` in `backend/src/config.ts`) runs the pipeline
  with scrape/dedup/enrich skipped and frames only the unframed retry
  queue — up to 14 clusters per run (14 × 3 worst-case Gemini attempts =
  42 subrequests < 50). The backlog that previously drained at 1–2
  clusters per run now drains in minutes, and the queue stays
  near-empty forever: no cluster can sit unframed for more than ~30
  minutes, so every card reliably gets its full framing report. When the
  queue is empty the run bails after a single read (before the lock) and
  records nothing — an idle framing cron costs ~1 D1 read per run.

### Changed

- **Every story card now shows an image.** Cards whose articles have no
  og:image used to render a bare "NO IMAGE" box; the hero now always runs
  the privacy-preserving fallback chain (og:image → site favicon →
  letter monogram, with the stripe pattern showing through at 30% in
  fallback states), so every cluster displays an image and the box is
  never empty. Zero extra requests — the browser fetches the favicon
  directly from the outlet.
- **Feed-carried images are captured at scrape time.** Google News embeds
  a thumbnail `<img>` in item descriptions and several direct feeds ship
  `<media:content>`/`<enclosure>` (The Hill, Sky News, …) — previously all
  discarded by the tag stripper. The scraper now extracts them
  (`extractFeedImage`, SSRF-gated through `isSafeHttpUrl`) into
  `imageUrl`, so those articles never need an og:image fetch at all.
- **og:image fetches send a browser-like UA.** The Hill, Sky News, DW and
  others return 403 to the previous `AntiSpinRead/1.0` bot UA; og:image is
  public page metadata, so the fetcher now identifies as a stock Chrome UA.
  The catch-up retries the backlogged articles with the new UA.
- **Text selection follows the story's theme.** Highlighting text on a
  story card or in the modal now highlights with that story's category
  color (each card/panel sets `--cat` from `categoryMeta().selection`);
  the acid-yellow selection remains only on chrome — header, ticker,
  filters.
- **OTHER cards get a white theme.** The "Other" category's ink outline
  and ink offset shadow were invisible against the black page; both are
  white now (solid `border-paper` outline + white offset shadow), the
  stamp's dashed border is gone, and text selection highlights white.

### Fixed

- **Stories stuck invisible — clustering only saw same-run articles.** Each
  15-minute run clustered just its ~10–15 new articles, but direct RSS feeds
  only surface each outlet's latest items, so the second outlet covering a
  story typically arrived in a *later* run and never matched. Result: 660
  unclustered articles sat in the window while the page showed the same 7
  stories for hours. The pipeline now clusters new articles **against the
  recent unclustered pool** (48h window, `recentUnclusteredArticles`, with a
  wider 128-cluster temporal window to reach stories published hours apart).
  Once formed, a cluster's articles leave the pool, so nothing re-creates.
- **Framing burst vs the free-plan subrequest budget.** The pool surfaced
  43 clusters in one run and the Workers free plan (50 outbound requests
  per invocation) failed every Gemini call with "Too many subrequests".
  Enrichment now uses `redirect: "manual"` (a redirect hop counts as a
  subrequest; news URLs chain 2–3), the scraper does the same for feeds
  (3xx → Google News fallback, 1 hop), and per-run batches are budgeted:
  `ENRICH_BATCH=8`, `ENRICH_CATCHUP=4`, `FRAMING_BATCH=3` (worst case
  ~45–49 of 50). Framing drains 3 clusters per run through the retry queue.
- **Redirecting direct feeds regressed to Google News titles.** With
  redirects no longer followed, 4 feeds (The Hill 308, Guardian/ABC/
  Al Jazeera 301) silently fell back to Google News, whose titles differ
  from the direct feed's — 457 near-duplicate articles and duplicate
  clusters. The feeds now point at their post-redirect canonical URLs
  (verified live), and the duplicate rows were purged.
- **Older stories showed no image.** Clusters formed before/without
  enrichment never got og:images. Backfilled via
  `scripts/backfill-images.ts` (local run against the D1 REST API), and
  the pipeline now runs a per-run enrichment catch-up
  (`articlesInClustersMissingImages`) so no cluster-referenced article
  stays image-less forever. Two follow-up backfills recovered the hard
  cases: `backfill-feed-images.ts` (matches feed-carried images to stored
  rows by URL — cleared Sky News/The Hill) and
  `backfill-follow-redirect.ts` (follows Google-News redirect chains
  locally, outside the Worker's subrequest budget — cleared NPR/USA Today
  and DW). Three articles are unreachable by any path (two outlets return
  403 to every client, one page ships no og:image) and show the favicon /
  monogram fallback until they age out.
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