import { scrapeAll, hashText } from "./scraper.js";
import { clusterArticles } from "./cluster.js";
import { frameCluster } from "./framing.js";
import { enrichArticleImages } from "./images.js";
import { workerConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Env, IFraming, PipelineResult, PipelineRunRecord } from "./types.js";
import type { ClusteredArticle } from "./cluster.js";

const FRAMING_CONCURRENCY = 3;
const RETRY_BATCH = 50;
// Workers free plan caps outbound requests at 50 per invocation. One run
// spends ~18-22 on RSS (a redirected direct feed costs 2: direct + Google
// News fallback), so enrichment and framing share the rest:
// (ENRICH_BATCH + ENRICH_CATCHUP) × 1 hop + FRAMING_BATCH × 5 (3 primary +
// 2 fallback attempts, worst case) → 12 + 15 = 27, ~45-49 total.
const ENRICH_BATCH = 8;
const ENRICH_CATCHUP = 4;
const FRAMING_BATCH = 3;
const RETENTION_DAYS = 14;
const RUNS_RETENTION_DAYS = 90; // pipeline_runs log is bound separately
const MAINTENANCE_INTERVAL_MS = 24 * 3600_000;
const PURGE_META_KEY = "last_purge_ms";

/** Deterministic cluster signature: hash of the sorted article keys. */
export function clusterSig(keys: string[]): string {
  return hashText([...keys].sort().join("|"));
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

type FrameFn = (
  cluster: ClusteredArticle[],
  opts: { apiKey: string; model: string }
) => Promise<IFraming>;

interface PipelineDeps {
  scrape?: typeof scrapeAll;
  frame?: FrameFn;
  enrich?: typeof enrichArticleImages;
}

interface PendingFraming {
  id: number;
  keyPhrase: string;
  sig: string;
  cluster: ClusteredArticle[];
}

/**
 * Maintenance chores piggybacked on pipeline runs but rate-limited by the
 * meta table: purge clusters + orphan articles older than RETENTION_DAYS
 * and run-log rows older than RUNS_RETENTION_DAYS, at most once per
 * MAINTENANCE_INTERVAL_MS. Returns what was purged, or null when
 * maintenance isn't due yet.
 */
export async function runMaintenance(
  db: Db
): Promise<{ clusters: number; articles: number; runs: number } | null> {
  const last = await db.getMeta(PURGE_META_KEY);
  const lastMs = last ? Number(last) : 0;
  const now = Date.now();
  if (Number.isFinite(lastMs) && now - lastMs < MAINTENANCE_INTERVAL_MS) {
    return null;
  }
  const cutoff = now - RETENTION_DAYS * 24 * 3600_000;
  const runsCutoff = now - RUNS_RETENTION_DAYS * 24 * 3600_000;
  const purged = await db.purgeOldData(cutoff, runsCutoff);
  await db.setMeta(PURGE_META_KEY, String(now));
  return purged;
}

/**
 * One full pipeline run: scrape -> dedup -> cluster -> frame -> maintain.
 * Overlapping runs are prevented by a D1 lock; clusters are deduplicated
 * by a deterministic signature; failed framings are retried on the next run.
 */
export async function runPipeline(
  env: Env,
  db: Db,
  deps: PipelineDeps = {}
): Promise<PipelineResult> {
  const scrape = deps.scrape ?? scrapeAll;
  const frame = deps.frame ?? frameCluster;
  const enrich = deps.enrich ?? enrichArticleImages;

  const lockToken = crypto.randomUUID();
  if (!(await db.acquirePipelineLock(lockToken))) {
    console.log("[pipeline] skipped: another run in progress");
    await recordRun(db, {
      startedAt: new Date(),
      finishedAt: new Date(),
      scraped: 0,
      newArticles: 0,
      clusters: 0,
      framed: 0,
      failed: 0,
      skipped: 1,
    });
    return { scraped: 0, newArticles: 0, clusters: 0, framed: 0, failed: 0, skipped: true };
  }

  const startedAt = new Date();
  try {
    const cfg = workerConfig(env);
    const raw = await scrape(cfg.clusterWindowHours);

    // 1. Insert only articles we haven't seen; returns the new ones
    const newArticles = await db.insertArticles(raw.filter((a) => a.url));
    console.log(`[pipeline] ${newArticles.length} new of ${raw.length} scraped`);

    // 2. Cluster the new articles AGAINST the recent unclustered pool.
    //    Direct RSS feeds only surface each outlet's latest items, so the
    //    second outlet covering a story often arrives runs — or hours —
    //    after the first. Clustering only same-run articles would leave
    //    those stories invisible forever; matching against the pool (48h
    //    window, not yet referenced by any cluster) catches them. Once a
    //    cluster is created its articles leave the pool, so re-runs can't
    //    re-create it (sig uniqueness + the EXISTS guard below).
    const poolArticles = [
      ...newArticles,
      ...(await db.recentUnclusteredArticles(
        new Date(Date.now() - cfg.clusterWindowHours * 3600_000),
        2000
      )),
    ];
    // The pool is ~10x bigger than a single run's batch, and the greedy
    // pass scans newest→oldest, so the temporal window must widen to reach
    // stories whose outlets published hours apart. 128 clusters ≈ ~9h of
    // news at current volume — still cheap (token-set Jaccards; the
    // threshold + rare-token boost keep unrelated stories out). Defaults
    // in cluster.ts stay at 8 for the eval corpus.
    const clusters = clusterArticles(poolArticles, { clusterWindow: 128 });

    // 2b. Enrich new-cluster articles with og:image URLs (best-effort,
    // only articles without an image yet; failures retry next run).
    // Capped at ENRICH_BATCH per run: a pool burst can surface 40+ clusters
    // at once, and each og:image fetch is a subrequest against the 50-per-
    // invocation budget. Uncapped articles are retried next run.
    const toEnrich = [...new Set(clusters.flat())].slice(0, ENRICH_BATCH);
    const enriched = await enrich(db, toEnrich);

    // 2c. Enrichment catch-up: older clusters' articles that still lack an
    // image (formed before enrichment existed, or publishers that blocked
    // the first attempt). Bounded to the subrequest budget.
    await enrich(db, await db.articlesInClustersMissingImages(ENRICH_CATCHUP));

    // 3. Collect clusters that still need framing: new ones first (create
    // the row now so re-runs don't reframe them), then previously failed
    // ones from the retry queue (framing IS NULL, oldest first).
    const pending: PendingFraming[] = [];

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const keys = cluster.map((a) => a.dedupKey);
      if (await db.clusterExistsWithFraming(keys)) continue;
      const phrase = cluster.map((a) => a.title).sort((x, y) => x.length - y.length)[0];
      const sig = clusterSig(keys);
      const id = await db.createCluster(phrase.slice(0, 300), keys, new Date(), sig);
      pending.push({ id, keyPhrase: phrase, sig, cluster });
    }

    const pendingSigs = new Set(pending.map((p) => p.sig));
    for (const r of await db.clustersNeedingFraming(RETRY_BATCH)) {
      const keys = r.articles.map((a) => a.dedupKey);
      if (pendingSigs.has(clusterSig(keys))) continue; // already queued above
      const cluster = r.articles.map((a) => ({
        ...a,
        tokens: [],
        tokenSet: new Set<string>(),
      })) as ClusteredArticle[];
      pending.push({ id: r.id, keyPhrase: r.keyPhrase, sig: clusterSig(keys), cluster });
    }

    // 4. Frame with bounded concurrency; a failure only marks that cluster.
    //    FRAMING_BATCH caps clusters per run (new first) so the burst
    //    doesn't exhaust the subrequest budget; the rest stay in the retry
    //    queue and get framed over the next runs.
    let framed = 0;
    let failed = 0;
    const framingQueue = pending.slice(0, FRAMING_BATCH);
    await pool(framingQueue, FRAMING_CONCURRENCY, async (p) => {
      try {
        const framing = await frame(p.cluster, {
          apiKey: cfg.geminiApiKey,
          model: cfg.geminiModel,
          fallbackModel: cfg.geminiModelFallback,
        });
        await db.saveFraming(p.id, framing, new Date(), null);
        framed++;
        console.log(`[pipeline] framed "${p.keyPhrase.slice(0, 60)}..."`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.saveFraming(p.id, null, null, message.slice(0, 500));
        failed++;
        console.warn(`[pipeline] framing failed: ${message.slice(0, 120)}`);
      }
    });

    console.log(
      `[pipeline] done: ${clusters.length} clusters, ${framed} framed, ${failed} failed, ${enriched} images`
    );

    // 5. Maintenance (retention purge) — at most once per 24h.
    const purged = await runMaintenance(db);
    if (purged) {
      console.log(
        `[pipeline] maintenance: purged ${purged.clusters} clusters, ${purged.articles} orphan articles, ${purged.runs} run log rows`
      );
    }

    await recordRun(db, {
      startedAt,
      finishedAt: new Date(),
      scraped: raw.length,
      newArticles: newArticles.length,
      clusters: clusters.length,
      framed,
      failed,
      skipped: 0,
    });

    return {
      scraped: raw.length,
      newArticles: newArticles.length,
      clusters: clusters.length,
      framed,
      failed,
    };
  } catch (err) {
    // Event log records failures too — the run stays visible to ops even
    // when an exception escapes the pipeline body.
    await recordRun(db, {
      startedAt,
      finishedAt: new Date(),
      scraped: 0,
      newArticles: 0,
      clusters: 0,
      framed: 0,
      failed: 0,
      skipped: 0,
      error: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
    throw err;
  } finally {
    await db.releasePipelineLock(lockToken);
  }
}

/** Append a run to the event log; logging failures must never crash the pipeline. */
async function recordRun(db: Db, run: PipelineRunRecord): Promise<void> {
  try {
    await db.recordPipelineRun(run);
  } catch (err) {
    console.warn(`[pipeline] failed to record run in event log: ${err}`);
  }
}