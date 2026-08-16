# ADR 0002 — D1 (SQLite) as the store

- **Status:** Accepted
- **Date:** 2026-08-15 (hardening pass, shipped as 1.0.0)
- **Deciders:** backend + docs (single-team project)

## Context

The pipeline needs durable state across runs:

- **Articles** — the pipeline's "memory" so a story is only framed once
  (`articles`, `dedup_key` primary key).
- **Clusters** — one row per cross-outlet story (`clusters`, with `sig` unique
  index for idempotent creation).
- **Cluster↔article membership** — `cluster_articles` join with FK cascade.
- **Framing reports** — Gemini output persisted per cluster as a JSON column.
- **Pipeline lock** — single-row `pipeline_lock` to serialize overlapping runs.
- **Maintenance state** — `meta` key/value (`last_purge_ms`) so retention jobs
  run at most once per 24h.
- **Event log** — `pipeline_runs`, one row per execution for observability.

Earlier iterations used MongoDB; the project moved to Cloudflare D1 (SQLite)
to eliminate all external infrastructure.

## Decision

D1 is the **only** store. Every table lives in one D1 database
(`anti-spin-read`), created via `npx wrangler d1 create`, bound as `DB`, and
migrated with `wrangler d1 migrations apply` (local and remote). Schema
changes are versioned SQL files in `backend/migrations/` (0001–0005).

## Why

- **SQLite compatibility, zero ops.** D1 is SQLite under the hood — real SQL,
  real constraints, real joins — with Cloudflare managing replication,
  backups, and capacity. No server, no connection pooling, no cost on the
  free tier (5 GB, 5M rows read/day, 1M rows written/day).
- **Transactions and constraints are the correctness story.** The cluster
  signature (`sig`) gets a **unique index**, so re-runs and overlapping runs
  can't duplicate rows. Foreign keys cascade cluster deletion to
  `cluster_articles`. The pipeline lock uses an `INSERT OR IGNORE` +
  conditional `UPDATE` (lease steal) on a `CHECK (id = 1)` single row. These
  are database guarantees, not app-level checks.
- **JSON columns for framing.** `clusters.framing` stores the validated
  framing report as JSON text — no second database, no schema churn when the
  framing shape evolves (it's versioned by the validator instead).
- **Real-SQLite test harness = correctness guarantee.** The killer argument:
  the data layer is tested against **real SQLite** (`better-sqlite3` +
  `scripts/sqlite-d1.ts`) with the **actual migration files** applied in
  order, exactly like `wrangler d1 migrations apply`. The old string-matching
  stub emulated behavior instead of executing SQL, which is how the
  ambiguous-column JOIN bug shipped. The harness executes every statement the
  production `D1Db` issues (including `batch()` in a transaction, with chunk
  sizes asserted: 100 for inserts, 90 for `IN` placeholders), so SQL syntax
  errors, ambiguous columns, constraint issues, and JOIN mistakes fail loudly.
  See `scripts/test-db-d1.ts` (44 assertions across 12 groups).

## Consequences / tradeoffs

- **D1 API shape, not raw SQLite.** Queries go through `D1Database` bindings
  (`.prepare().bind().all()/run()`, `.batch()`). Bound-parameter limits (100
  per statement) drive the chunking (90-placeholder `IN` queries, 100-row
  batches).
- **Read amplification on the free tier.** The read API (page views, polls)
  reads D1 on every request; mitigated by the Workers Cache API edge cache on
  `/api/clusters` (60s) — see ADR 0001.
- **Storage is bounded by design.** The free tier is not unlimited, so
  retention is a first-class feature, not an afterthought.

## Retention + purge design

- **Retention window:** 14 days (`RETENTION_DAYS` in `pipeline.ts`).
- **Purge semantics** (`D1Db.purgeOldData`, migration-tested):
  - `DELETE FROM clusters WHERE seen_at < cutoff` — cascades to
    `cluster_articles` via FK.
  - `DELETE FROM articles WHERE published_at < cutoff AND NOT EXISTS
    (cluster_articles reference)` — removes orphans only; **recent**
    unreferenced articles stay, because a late-arriving second outlet may
    still cluster with them next run.
  - `DELETE FROM pipeline_runs WHERE started_at < runs_cutoff` — the event
    log is bound separately with a **90-day retention**
    (`RUNS_RETENTION_DAYS`), so the one-row-per-run table (~35k rows/year)
    cannot grow without bound.
- **Rate-limited maintenance:** `runMaintenance` runs as the last step of each
  pipeline run but executes the purge at most once per 24h
  (`MAINTENANCE_INTERVAL_MS`), gated by `meta.last_purge_ms`
  (`PURGE_META_KEY`) — maintenance state lives in the same store, so any
  isolate can check it.
- **Why 14 days:** the product surface is "recent cross-outlet framing
  comparisons"; 14 days of clusters/articles comfortably covers the 48h
  clustering window (`CLUSTER_WINDOW_HOURS`) with headroom, while keeping the
  free-tier row budgets safe.

## Alternatives considered

- **MongoDB** (used earlier): external infra, cost, ops — replaced by D1.
- **KV:** no queries, no joins, no constraints — unsuitable for clusters +
  membership.
- **Durable Objects / other:** overkill; D1's SQLite semantics match the
  relational shape of the domain exactly.