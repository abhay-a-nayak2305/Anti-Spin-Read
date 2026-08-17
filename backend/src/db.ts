import type { D1Database } from "@cloudflare/workers-types";
import { parseFraming } from "./framing-schema.js";
import type { ClusterRecord, IFraming, PipelineRunRecord, RawArticle } from "./types.js";

/**
 * Data-access contract used by the pipeline and the API.
 * The production implementation talks to Cloudflare D1; tests and the
 * seeded UI server use the in-memory implementation.
 */
export interface Db {
  /** Insert articles that aren't stored yet; returns only the newly inserted ones */
  insertArticles(articles: RawArticle[]): Promise<RawArticle[]>;
  recentArticles(since: Date): Promise<RawArticle[]>;
  /**
   * Articles published since `since` that no cluster references yet —
   * the clustering pool. A story's second outlet can arrive runs/hours
   * after the first; those late articles must still cluster.
   */
  recentUnclusteredArticles(since: Date, limit: number): Promise<RawArticle[]>;
  /**
   * Cluster-referenced articles that still lack an og:image — the
   * enrichment catch-up queue. New clusters are enriched in the run that
   * creates them; this covers older clusters (e.g. formed before
   * enrichment existed) and articles whose publisher blocked the first
   * attempt. Bounded per run to the subrequest budget.
   */
  articlesInClustersMissingImages(limit: number): Promise<RawArticle[]>;
  /** Has any framed cluster already used one of these article keys? */
  clusterExistsWithFraming(keys: string[]): Promise<boolean>;
  /**
   * Create a cluster. `sig` is a deterministic hash of the sorted article
   * keys, so re-runs and overlapping runs return the existing cluster id
   * instead of duplicating rows (unique index on clusters.sig).
   */
  createCluster(
    keyPhrase: string,
    articleKeys: string[],
    seenAt: Date,
    sig: string
  ): Promise<number>;
  saveFraming(
    id: number,
    framing: IFraming | null,
    framedAt: Date | null,
    error: string | null
  ): Promise<void>;
  /** Persist an og:image URL discovered during enrichment */
  setArticleImage(dedupKey: string, imageUrl: string): Promise<void>;
  latestClusters(limit: number, offset?: number): Promise<ClusterRecord[]>;
  /**
   * Clusters whose key phrase, or any referenced article's title/lede,
   * contains `query` (case-insensitive), newest first.
   */
  searchClusters(query: string, limit: number): Promise<ClusterRecord[]>;
  /** A single cluster by numeric id — null when missing (e.g. purged). */
  clusterById(id: string): Promise<ClusterRecord | null>;
  /**
   * Cluster ids + last-seen for sitemap generation (no article/framing
   * payload — a light read for crawlers).
   */
  sitemapMeta(limit: number): Promise<{ id: string; seenAt: Date }[]>;
  /**
   * Clusters whose framing is still NULL (never attempted or failed),
   * oldest first — the retry queue for the pipeline.
   */
  clustersNeedingFraming(
    limit: number
  ): Promise<{ id: number; keyPhrase: string; articles: RawArticle[] }[]>;
  /**
   * Single-slot pipeline lock (D1 row id=1). Steals the lock when the
   * previous holder's lease (15 min) has expired. Returns false when
   * another run holds the lock.
   */
  acquirePipelineLock(token: string): Promise<boolean>;
  /** Release the lock only if this run still owns it */
  releasePipelineLock(token: string): Promise<void>;
  /**
   * Retention purge: delete clusters (and their cluster_articles via FK
   * cascade) whose seen_at is older than cutoffMs, articles that are no
   * longer referenced by any cluster and older than cutoffMs, and pipeline
   * run log rows older than runsCutoffMs (the run log has its own, longer
   * retention). Returns rows deleted per table.
   */
  purgeOldData(
    cutoffMs: number,
    runsCutoffMs: number
  ): Promise<{ clusters: number; articles: number; runs: number }>;
  /** Maintenance state (retention timestamps, job markers). */
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /** Append a pipeline run to the event log (observability). */
  recordPipelineRun(run: PipelineRunRecord): Promise<void>;
  /** Most recent pipeline runs, newest first. */
  latestPipelineRuns(limit: number): Promise<PipelineRunRecord[]>;
}

const ARTICLE_COLS =
  "dedup_key, source, title, url, lede, published_at, image_url";

function toRaw(row: Record<string, unknown>): RawArticle {
  return {
    dedupKey: String(row.dedup_key),
    source: String(row.source),
    title: String(row.title),
    url: String(row.url),
    lede: String(row.lede ?? ""),
    publishedAt: new Date(Number(row.published_at)),
    imageUrl: String(row.image_url ?? ""),
  };
}

/** Run `fn` over `items` in chunks of `size` (D1 batches cap at 100). */
async function chunked<T>(
  items: T[],
  size: number,
  fn: (chunk: T[]) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await fn(items.slice(i, i + size));
  }
}

/**
 * Build the `?, ?, ...` placeholder string for `n` params.
 * Kept at 90 because D1's per-statement bound-param limit is 100;
 * 90 leaves headroom.
 */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** Cloudflare D1 (SQLite) implementation */
export class D1Db implements Db {
  constructor(private env: D1Database) {}

  async insertArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const inserted: RawArticle[] = [];
    const stmt = (a: RawArticle) =>
      this.env
        .prepare(
          `INSERT OR IGNORE INTO articles (${ARTICLE_COLS})
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          a.dedupKey,
          a.source,
          a.title,
          a.url,
          a.lede,
          a.publishedAt.getTime(),
          a.imageUrl ?? ""
        );

    await chunked(articles, 100, async (chunk) => {
      const results = await this.env.batch(chunk.map(stmt));
      chunk.forEach((a, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) inserted.push(a);
      });
    });
    return inserted;
  }

  async articlesInClustersMissingImages(limit: number): Promise<RawArticle[]> {
    const { results } = await this.env
      .prepare(
        `SELECT DISTINCT a.${ARTICLE_COLS.replaceAll(", ", ", a.")} FROM articles a
         JOIN cluster_articles ca ON ca.dedup_key = a.dedup_key
         WHERE a.image_url = ''
         ORDER BY a.published_at DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();
    return results.map(toRaw);
  }

  async recentArticles(since: Date): Promise<RawArticle[]> {
    const { results } = await this.env
      .prepare(
        `SELECT ${ARTICLE_COLS} FROM articles
         WHERE published_at >= ? ORDER BY published_at DESC`
      )
      .bind(since.getTime())
      .all();
    return results.map(toRaw);
  }

  async recentUnclusteredArticles(
    since: Date,
    limit: number
  ): Promise<RawArticle[]> {
    const { results } = await this.env
      .prepare(
        `SELECT a.${ARTICLE_COLS.replaceAll(", ", ", a.")} FROM articles a
         WHERE a.published_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM cluster_articles ca WHERE ca.dedup_key = a.dedup_key
           )
         ORDER BY a.published_at DESC
         LIMIT ?`
      )
      .bind(since.getTime(), limit)
      .all();
    return results.map(toRaw);
  }

  async clusterExistsWithFraming(keys: string[]): Promise<boolean> {
    if (keys.length === 0) return false;
    let found = false;
    await chunked(keys, 90, async (part) => {
      if (found) return;
      const { results } = await this.env
        .prepare(
          `SELECT 1 FROM cluster_articles ca
           JOIN clusters c ON c.id = ca.cluster_id
           WHERE ca.dedup_key IN (${placeholders(part.length)}) AND c.framing IS NOT NULL
           LIMIT 1`
        )
        .bind(...part)
        .all();
      if (results.length > 0) found = true;
    });
    return found;
  }

  async createCluster(
    keyPhrase: string,
    articleKeys: string[],
    seenAt: Date,
    sig: string
  ): Promise<number> {
    await this.env
      .prepare(
        "INSERT OR IGNORE INTO clusters (key_phrase, seen_at, sig) VALUES (?, ?, ?)"
      )
      .bind(keyPhrase, seenAt.getTime(), sig)
      .run();
    const { results } = await this.env
      .prepare("SELECT id FROM clusters WHERE sig = ?")
      .bind(sig)
      .all();
    const id = Number(results[0]?.id);

    const stmts = articleKeys.map((k) =>
      this.env
        .prepare(
          "INSERT OR IGNORE INTO cluster_articles (cluster_id, dedup_key) VALUES (?, ?)"
        )
        .bind(id, k)
    );
    await chunked(stmts, 100, async (chunk) => {
      await this.env.batch(chunk);
    });
    return id;
  }

  async saveFraming(
    id: number,
    framing: IFraming | null,
    framedAt: Date | null,
    error: string | null
  ): Promise<void> {
    await this.env
      .prepare(
        "UPDATE clusters SET framing = ?, framed_at = ?, framing_error = ? WHERE id = ?"
      )
      .bind(
        framing ? JSON.stringify(framing) : null,
        framedAt ? framedAt.getTime() : null,
        error,
        id
      )
      .run();
  }

  async setArticleImage(dedupKey: string, imageUrl: string): Promise<void> {
    await this.env
      .prepare("UPDATE articles SET image_url = ? WHERE dedup_key = ?")
      .bind(imageUrl, dedupKey)
      .run();
  }

  async latestClusters(limit: number, offset = 0): Promise<ClusterRecord[]> {
    // Two queries: first the clusters themselves (LIMIT applies to clusters,
    // not joined rows — a single joined query would truncate the cluster
    // straddling the limit), then their articles in one IN query.
    const { results } = await this.env
      .prepare(
        `SELECT c.id AS c_id, c.key_phrase, c.seen_at, c.framed_at, c.framing_error, c.framing
         FROM clusters c
         ORDER BY c.framed_at IS NULL, c.framed_at DESC, c.seen_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(limit, offset)
      .all();

    return this.hydrate(results);
  }

  async searchClusters(query: string, limit: number): Promise<ClusterRecord[]> {
    // LIKE is ASCII-case-insensitive in SQLite; the pattern escapes the
    // LIKE metacharacters (%, _, \) so user input can't widen the match.
    const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const { results } = await this.env
      .prepare(
        `SELECT c.id AS c_id, c.key_phrase, c.seen_at, c.framed_at, c.framing_error, c.framing
         FROM clusters c
         WHERE c.key_phrase LIKE ? ESCAPE '\\'
            OR EXISTS (
              SELECT 1
              FROM cluster_articles ca
              JOIN articles a ON a.dedup_key = ca.dedup_key
              WHERE ca.cluster_id = c.id
                AND (a.title LIKE ? ESCAPE '\\' OR a.lede LIKE ? ESCAPE '\\')
            )
         ORDER BY c.seen_at DESC
         LIMIT ?`
      )
      .bind(pattern, pattern, pattern, limit)
      .all();

    return this.hydrate(results);
  }

  async clusterById(id: string): Promise<ClusterRecord | null> {
    const { results } = await this.env
      .prepare(
        `SELECT c.id AS c_id, c.key_phrase, c.seen_at, c.framed_at, c.framing_error, c.framing
         FROM clusters c
         WHERE c.id = ?
         LIMIT 1`
      )
      .bind(id)
      .all();
    if (results.length === 0) return null;
    const hydrated = await this.hydrate(results);
    return hydrated[0] ?? null;
  }

  async sitemapMeta(limit: number): Promise<{ id: string; seenAt: Date }[]> {
    const { results } = await this.env
      .prepare(
        `SELECT id, seen_at FROM clusters ORDER BY seen_at DESC LIMIT ?`
      )
      .bind(limit)
      .all();
    return results.map((r) => ({
      id: String(r.id),
      seenAt: new Date(Number(r.seen_at)),
    }));
  }

  /**
   * Map cluster rows (aliased c_id) to ClusterRecords, validating framing
   * JSON at rest (a corrupt row is skipped, never served) and loading each
   * cluster's articles in one chunked IN query.
   */
  private async hydrate(rows: Record<string, unknown>[]): Promise<ClusterRecord[]> {
    const clusters: ClusterRecord[] = [];
    const byId = new Map<number, ClusterRecord>();
    for (const row of rows) {
      const id = Number(row.c_id);
      let framing: IFraming | null = null;
      if (row.framing != null) {
        // Structural validation on read too: a row that fails the same
        // rules we apply to model output is treated as corrupt and skipped.
        framing = parseFraming(String(row.framing));
        if (!framing) {
          console.warn(`[db] skipping cluster ${id}: corrupt framing JSON`);
          continue;
        }
      }
      const rec: ClusterRecord = {
        id: String(id),
        keyPhrase: String(row.key_phrase),
        seenAt: new Date(Number(row.seen_at)),
        framedAt: row.framed_at == null ? null : new Date(Number(row.framed_at)),
        framingError: row.framing_error == null ? null : String(row.framing_error),
        framing,
        articles: [],
      };
      clusters.push(rec);
      byId.set(id, rec);
    }

    if (clusters.length > 0) {
      const ids = [...byId.keys()];
      await chunked(ids, 90, async (part) => {
        const { results: rows } = await this.env
          .prepare(
            `SELECT ca.cluster_id, a.dedup_key, a.source, a.title, a.url, a.lede,
                    a.published_at, a.image_url
             FROM cluster_articles ca
             JOIN articles a ON a.dedup_key = ca.dedup_key
             WHERE ca.cluster_id IN (${placeholders(part.length)})`
          )
          .bind(...part)
          .all();
        for (const row of rows) {
          byId.get(Number(row.cluster_id))?.articles.push(toRaw(row));
        }
      });
    }

    return clusters;
  }

  async clustersNeedingFraming(limit: number): Promise<
    { id: number; keyPhrase: string; articles: RawArticle[] }[]
  > {
    const { results } = await this.env
      .prepare(
        `SELECT c.id AS c_id, c.key_phrase
         FROM clusters c
         WHERE c.framing IS NULL
         ORDER BY c.seen_at ASC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    const out: { id: number; keyPhrase: string; articles: RawArticle[] }[] = [];
    const ids: number[] = [];
    for (const row of results) {
      const id = Number(row.c_id);
      out.push({ id, keyPhrase: String(row.key_phrase), articles: [] });
      ids.push(id);
    }

    if (ids.length > 0) {
      await chunked(ids, 90, async (part) => {
        const { results: rows } = await this.env
          .prepare(
            `SELECT ca.cluster_id, a.dedup_key, a.source, a.title, a.url, a.lede,
                    a.published_at, a.image_url
             FROM cluster_articles ca
             JOIN articles a ON a.dedup_key = ca.dedup_key
             WHERE ca.cluster_id IN (${placeholders(part.length)})`
          )
          .bind(...part)
          .all();
        for (const row of rows) {
          const rec = out.find((o) => o.id === Number(row.cluster_id));
          if (rec) rec.articles.push(toRaw(row));
        }
      });
    }
    return out;
  }

  async acquirePipelineLock(token: string): Promise<boolean> {
    const now = Date.now();
    const res = await this.env
      .prepare(
        "INSERT OR IGNORE INTO pipeline_lock (id, token, acquired_at) VALUES (1, ?, ?)"
      )
      .bind(token, now)
      .run();
    if ((res.meta.changes ?? 0) > 0) return true;

    const { results } = await this.env
      .prepare("SELECT token, acquired_at FROM pipeline_lock WHERE id = 1")
      .all();
    const row = results[0];
    if (!row) return true; // raced deletion; next INSERT will claim it
    if (row.token === token) return true;
    // Lease expired (15 min)? Steal the lock. The watchdog (12 min) releases
    // the lock when the run's isolate is still alive; the lease is the
    // backstop for platform-frozen zombies, so recovery never waits for the
    // full lease — 15 min is the worst a stale lock can block the pipeline.
    if (Number(row.acquired_at) < now - 15 * 60_000) {
      const stolen = await this.env
        .prepare(
          "UPDATE pipeline_lock SET token = ?, acquired_at = ? WHERE id = 1 AND acquired_at < ?"
        )
        .bind(token, now, now - 15 * 60_000)
        .run();
      return (stolen.meta.changes ?? 0) > 0;
    }
    return false;
  }

  async releasePipelineLock(token: string): Promise<void> {
    await this.env
      .prepare("DELETE FROM pipeline_lock WHERE id = 1 AND token = ?")
      .bind(token)
      .run();
  }

  async purgeOldData(
    cutoffMs: number,
    runsCutoffMs: number
  ): Promise<{ clusters: number; articles: number; runs: number }> {
    // Clusters cascade to cluster_articles via the FK. Articles that are
    // both older than the cutoff AND no longer referenced by any cluster
    // are orphans — remove them too so the articles table doesn't grow
    // forever on the free tier. Recent unreferenced articles stay: a
    // late-arriving second outlet may still cluster with them next run.
    const clusterRes = await this.env
      .prepare("DELETE FROM clusters WHERE seen_at < ?")
      .bind(cutoffMs)
      .run();
    const articleRes = await this.env
      .prepare(
        `DELETE FROM articles
         WHERE published_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM cluster_articles ca WHERE ca.dedup_key = articles.dedup_key
           )`
      )
      .bind(cutoffMs)
      .run();
    // The run event log keeps a row per 15-minute run forever otherwise
    // (~35k rows/year) — bound it with its own longer retention.
    const runsRes = await this.env
      .prepare("DELETE FROM pipeline_runs WHERE started_at < ?")
      .bind(runsCutoffMs)
      .run();
    return {
      clusters: clusterRes.meta.changes ?? 0,
      articles: articleRes.meta.changes ?? 0,
      runs: runsRes.meta.changes ?? 0,
    };
  }

  async getMeta(key: string): Promise<string | null> {
    const { results } = await this.env
      .prepare("SELECT value FROM meta WHERE key = ?")
      .bind(key)
      .all();
    const row = results[0];
    return row ? String(row.value) : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.env
      .prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(key, value, Date.now())
      .run();
  }

  async recordPipelineRun(run: PipelineRunRecord): Promise<void> {
    await this.env
      .prepare(
        `INSERT INTO pipeline_runs
           (started_at, finished_at, scraped, new_articles, clusters, framed, failed, skipped, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        run.startedAt.getTime(),
        run.finishedAt.getTime(),
        run.scraped,
        run.newArticles,
        run.clusters,
        run.framed,
        run.failed,
        run.skipped,
        run.error ?? null
      )
      .run();
  }

  async latestPipelineRuns(limit: number): Promise<PipelineRunRecord[]> {
    const { results } = await this.env
      .prepare(
        `SELECT id, started_at, finished_at, scraped, new_articles, clusters,
                framed, failed, skipped, error
         FROM pipeline_runs
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();
    return results.map((r) => ({
      id: Number(r.id),
      startedAt: new Date(Number(r.started_at)),
      finishedAt: new Date(Number(r.finished_at)),
      scraped: Number(r.scraped),
      newArticles: Number(r.new_articles),
      clusters: Number(r.clusters),
      framed: Number(r.framed),
      failed: Number(r.failed),
      skipped: Number(r.skipped),
      error: r.error == null ? null : String(r.error),
    }));
  }
}