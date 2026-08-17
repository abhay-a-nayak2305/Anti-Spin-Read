# AGENTS.md — Guide for coding agents

This file is the contract for AI coding agents and human contributors working
in this repository. Read it before editing. If a change contradicts a rule
below, stop and ask.

## Repo layout

```
backend/                 Cloudflare Worker (Hono + TypeScript) — API + pipeline
  src/index.ts           app factory (createApp), routes, security headers, cron handler
  src/config.ts          worker config (env vars, sources list, CORS allowlist)
  src/types.ts           shared types (RawArticle, IFraming, ClusterRecord, Env…)
  src/db.ts              Db interface + D1Db implementation (the only data layer)
  src/db-memory.ts       MemoryDb — in-memory Db implementation for tests/e2e
  src/pipeline.ts        runPipeline (scrape → dedup → cluster → frame → maintain → log)
  src/scraper.ts         Google News RSS fetching + cleaning (timeouts, caps, suffixes)
  src/cluster.ts         tokenize + clusterArticles (Jaccard + rare-token boost, CJK bigrams)
  src/framing.ts         frameCluster — Gemini call (responseSchema, retries, model fallback)
  src/framing-schema.ts  normalizeFraming / parseFraming — the framing validation gate
  src/images.ts          isSafeHttpUrl (SSRF guard), og:image enrichment
  src/categorize.ts      deterministic keyword categorization (no LLM)
  src/rate-limit.ts      in-memory sliding-window rate limiter
  migrations/            versioned SQL (0001–0005) applied by wrangler + test harness
  scripts/               test suites, evals, seeders, sqlite-d1.ts (D1 test harness)
  wrangler.jsonc         Worker config: D1 binding, ASSETS, cron trigger, vars
frontend/                React + Vite + Tailwind SPA (built into Worker assets)
  src/                   App, components, hooks (useClusters polling/pagination), types
  tests/                 Playwright UI smoke test (ui_test.py)
.github/workflows/       ci.yml (tests + eval gates + audit + live e2e), deploy.yml
.github/dependabot.yml   weekly npm / monthly actions updates
docs/                    architecture.md, api.md, adr/0001–0003
CHANGELOG.md             keep-a-changelog format
```

## Commands

Backend (run from `backend/`):

```bash
npm run typecheck        # strict TS, src + scripts (tsc --noEmit + tsconfig.scripts.json)
npm test                 # 8 suites, offline: test-cluster, test-framing, test-categorize,
                         #   test-images, test-scraper, test-db-d1 (REAL SQLite + real
                         #   migrations), test-pipeline, test-api (real Hono app, in-memory Db)
npm run test:d1          # data layer only (real SQLite harness)
npm run test:api         # API integration only
npm run test:e2e         # live pipeline e2e (live RSS, in-memory Db) — network-dependent
npm run eval:framing     # framing eval gate (offline corpus; --live with GEMINI_API_KEY)
npx tsx scripts/eval-cluster.ts   # clustering eval gate (bilingual corpus)
npm run migrate:local    # apply D1 migrations to local DB
npm run migrate:remote   # apply D1 migrations to remote DB (deploy workflow does this)
npm run dev              # wrangler dev (:8787)
```

Frontend (run from `frontend/`):

```bash
npm test                 # vitest + testing-library (jsdom)
npm run lint             # oxlint
npm run build            # tsc -b && vite build → dist/ (served by the Worker's ASSETS)
```

CI (`.github/workflows/ci.yml`) runs: backend typecheck + `npm test`;
frontend lint + test + build; framing-eval and cluster-eval gates; `npm audit
--audit-level=high` on both packages; and a live pipeline e2e on `main` only.

## Eval gates (do not weaken)

- **`scripts/eval-framing.ts`** — replays an offline corpus of realistic
  Gemini outputs (fenced, prose-wrapped, bad tones, overlong, garbage,
  empty-summary, non-object) through the real `frameCluster` +
  `normalizeFraming` path. Garbage must be REJECTED, valid output must PARSE.
  Run it after any change to `framing.ts`, `framing-schema.ts`, or the
  prompt. Live mode: `GEMINI_API_KEY=... npx tsx scripts/eval-framing.ts
  --live` (scores ≥ 4/6).
- **`scripts/eval-cluster.ts`** — bilingual (EN/AR/ZH) labeled corpus through
  `clusterArticles`. Gates: precision ≥ 0.8, recall ≥ 0.7, no cross-story
  mixing. Run after any change to `cluster.ts` (tokenizer, thresholds,
  stopwords, CJK handling, windowing).

## Migration workflow

1. Add `backend/migrations/NNNN_name.sql` (next number; each file applies to
   the existing schema — ALTER/ADD, never rewrite old files).
2. Add the filename to the `MIGRATION_FILES` list in
   `backend/scripts/sqlite-d1.ts` — **in order**. This is what keeps the test
   harness's schema identical to production.
3. Apply locally: `npm run migrate:local` (`wrangler d1 migrations apply
   anti-spin-read --local`).
4. Add/extend coverage in `backend/scripts/test-db-d1.ts` so the new schema is
   exercised through the real-SQLite harness (the harness executes the actual
   migration SQL — syntax errors and constraint issues fail loudly there).
5. CI + the deploy workflow (`deploy.yml` applies migrations remotely before
   `wrangler deploy`) handle the rest; never hand-apply SQL to the remote DB.

## Security rules (non-negotiable)

- **SSRF guard: `isSafeHttpUrl` in `backend/src/images.ts`.** Every URL that
  comes from feed data (article URLs, og:image URLs) must pass through it —
  at fetch time (scraper/enrichment, incl. post-redirect re-check) and at
  serve time (`/api/clusters` re-checks and serves `""` for unsafe URLs).
  It rejects non-http(s) schemes, private/reserved IPv4 in ANY encoding
  (decimal/hex/octal/short forms), reserved IPv6 (incl. IPv4-mapped), FQDN
  trailing dots, and reserved suffixes (`.local`, `.internal`, `.localhost`,
  `.test`, `.invalid`, `.home.arpa`). Do not weaken the parser; add tests for
  new vectors.
- **CSP and friends: `applySecurityHeaders` in `backend/src/index.ts`.**
  Every response — API, SPA, cached, 404 — must carry the CSP (currently
  `connect-src 'self'` and friends), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. Never serve a
  response with immutable headers from `ASSETS.fetch` without copying it into
  a mutable `Response` first (that was a shipped 500 bug).
- **Constant-time secret compare.** `secretsEqual` in `index.ts` (manual XOR
  accumulation; `crypto.subtle.timingSafeEqual` is not in the WebCrypto spec
  for Workers). Lengths are compared separately (not secret). Never replace
  with `===` or `String.includes`.
- **Fail-closed cron.** `POST /api/cron` returns 503 when `CRON_SECRET` is
  unset — there is NO default secret. Never add a fallback secret.
- **Never log secrets or query strings.** Structured logs record path only,
  never raw query strings (URLs in query params can carry sensitive
  fragments), and never the Gemini API key.
- **Client-facing errors are generic.** Real Gemini error details live in D1
  (`framing_error`) for the operator; the API serves `"Framing failed"` or
  `{"error": "internal error"}`.

## Architecture rules

- **D1 is the only store; Workers are stateless.** No KV/R2/DO state. The
  per-isolate in-memory rate limiter is the sole exception (documented in
  `docs/architecture.md`).
- **Data access only through the `Db` interface** (`backend/src/db.ts`).
  `D1Db` (production) and `MemoryDb` (`db-memory.ts`, tests/e2e/seeded UI)
  must stay behaviorally **in parity** — a change to one needs a change to
  the other. Routes and the pipeline take `Db`, never a raw D1 binding.
- **Never bypass the Db abstraction in routes.** `index.ts` must not run SQL
  directly; it calls `resolveDb(env)`.
- **Idempotency is a database property.** Cluster signature `sig` has a
  unique index; pipeline lock is a single row with a 15-min lease; inserts
  are `INSERT OR IGNORE`. Don't replace these with app-level checks.
- **Framing JSON is validated at rest.** Same `normalizeFraming` rules on
  write (frameCluster) and read (D1Db parse) — a corrupt row is skipped, never
  served. "No silent degradation": empty successes are failures.
- **Batch discipline for D1.** Inserts batch at 100 statements;
  `IN (...)` clauses chunk at 90 placeholders (D1's per-statement bound-param
  limit is 100). The SQLite harness asserts chunk sizes.
- **The SPA is part of the Worker.** `frontend/dist` is served via ASSETS
  with `run_worker_first`. Deploy builds it first; keep the API and SPA
  contract in sync (frontend `types.ts` mirrors the API shapes — update both
  together).

## Golden rules

- **Never commit secrets.** `GEMINI_API_KEY` and `CRON_SECRET` go through
  `npx wrangler secret put` (production) or `.dev.vars` (local, gitignored).
  `.dev.vars.example` documents the names only.
- **`GEMINI_API_KEY` is invalid locally.** Do not treat the local environment
  as having a working key; pipeline tests must pass without one (framing
  failures record `framing_error`, e2e asserts no framing succeeds without a
  key).
- **Never invent requirements.** Document only what the user or orchestrator
  approved; flag ambiguity instead of guessing.
- **Keep docs honest.** If code changes a contract, update `docs/api.md`,
  `docs/architecture.md`, the ADRs, and `CHANGELOG.md` in the same change.
- **Do not weaken eval gates or test suites** to make a change pass; fix the
  change.