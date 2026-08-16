import type { Db } from "./db.js";
import type { ClusterRecord, IFraming, PipelineRunRecord, RawArticle } from "./types.js";

/**
 * In-memory Db implementation — used by the test scripts and the seeded
 * UI server so they never need a database.
 */
export class MemoryDb implements Db {
  articles = new Map<string, RawArticle>();
  clusters: {
    id: number;
    keyPhrase: string;
    articleKeys: string[];
    seenAt: Date;
    framedAt: Date | null;
    framingError: string | null;
    framing: IFraming | null;
    sig: string;
  }[] = [];
  private nextId = 1;
  // Public for tests to assert lock semantics
  lock: { token: string; acquiredAt: number } | null = null;

  async insertArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const inserted: RawArticle[] = [];
    for (const a of articles) {
      if (!this.articles.has(a.dedupKey)) {
        this.articles.set(a.dedupKey, a);
        inserted.push(a);
      }
    }
    return inserted;
  }

  async recentArticles(since: Date): Promise<RawArticle[]> {
    return [...this.articles.values()]
      .filter((a) => a.publishedAt >= since)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  }

  async recentUnclusteredArticles(
    since: Date,
    limit: number
  ): Promise<RawArticle[]> {
    const referenced = new Set(this.clusters.flatMap((c) => c.articleKeys));
    return [...this.articles.values()]
      .filter(
        (a) =>
          a.publishedAt >= since &&
          !referenced.has(a.dedupKey)
      )
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, limit);
  }

  async clusterExistsWithFraming(keys: string[]): Promise<boolean> {
    return this.clusters.some(
      (c) => c.framing !== null && keys.some((k) => c.articleKeys.includes(k))
    );
  }

  async createCluster(
    keyPhrase: string,
    articleKeys: string[],
    seenAt: Date,
    sig: string
  ): Promise<number> {
    const existing = this.clusters.find((c) => c.sig === sig);
    if (existing) return existing.id;
    const id = this.nextId++;
    this.clusters.push({
      id,
      keyPhrase,
      articleKeys: [...articleKeys],
      seenAt,
      framedAt: null,
      framingError: null,
      framing: null,
      sig,
    });
    return id;
  }

  async saveFraming(
    id: number,
    framing: IFraming | null,
    framedAt: Date | null,
    error: string | null
  ): Promise<void> {
    const c = this.clusters.find((x) => x.id === id);
    if (!c) return;
    c.framing = framing;
    c.framedAt = framedAt;
    c.framingError = error;
  }

  async setArticleImage(dedupKey: string, imageUrl: string): Promise<void> {
    const a = this.articles.get(dedupKey);
    if (a) a.imageUrl = imageUrl;
  }

  async latestClusters(limit: number, offset = 0): Promise<ClusterRecord[]> {
    const sorted = [...this.clusters].sort((a, b) => {
      const af = a.framedAt?.getTime() ?? -Infinity;
      const bf = b.framedAt?.getTime() ?? -Infinity;
      if (bf !== af) return bf - af;
      return b.seenAt.getTime() - a.seenAt.getTime();
    });
    return sorted.slice(offset, offset + limit).map((c) => ({
      id: String(c.id),
      keyPhrase: c.keyPhrase,
      seenAt: c.seenAt,
      framedAt: c.framedAt,
      framingError: c.framingError,
      framing: c.framing,
      articles: c.articleKeys
        .map((k) => this.articles.get(k))
        .filter((a): a is RawArticle => !!a),
    }));
  }

  async clustersNeedingFraming(limit: number): Promise<
    { id: number; keyPhrase: string; articles: RawArticle[] }[]
  > {
    return this.clusters
      .filter((c) => c.framing === null)
      .sort((a, b) => a.seenAt.getTime() - b.seenAt.getTime())
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        keyPhrase: c.keyPhrase,
        articles: c.articleKeys
          .map((k) => this.articles.get(k))
          .filter((a): a is RawArticle => !!a),
      }));
  }

  async acquirePipelineLock(token: string): Promise<boolean> {
    const now = Date.now();
    if (!this.lock) {
      this.lock = { token, acquiredAt: now };
      return true;
    }
    if (this.lock.token === token) return true;
    if (this.lock.acquiredAt < now - 30 * 60_000) {
      this.lock = { token, acquiredAt: now };
      return true;
    }
    return false;
  }

  async releasePipelineLock(token: string): Promise<void> {
    if (this.lock?.token === token) this.lock = null;
  }

  private meta = new Map<string, string>();

  async purgeOldData(
    cutoffMs: number,
    runsCutoffMs: number
  ): Promise<{ clusters: number; articles: number; runs: number }> {
    let clusters = 0;
    const before = this.clusters.length;
    this.clusters = this.clusters.filter((c) => c.seenAt.getTime() >= cutoffMs);
    clusters = before - this.clusters.length;

    const referenced = new Set(
      this.clusters.flatMap((c) => c.articleKeys)
    );
    let articles = 0;
    for (const key of [...this.articles.keys()]) {
      const a = this.articles.get(key)!;
      if (a.publishedAt.getTime() < cutoffMs && !referenced.has(key)) {
        this.articles.delete(key);
        articles++;
      }
    }

    let runs = 0;
    const runsBefore = this.runs.length;
    this.runs = this.runs.filter((r) => r.startedAt.getTime() >= runsCutoffMs);
    runs = runsBefore - this.runs.length;
    return { clusters, articles, runs };
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }

  private runs: PipelineRunRecord[] = [];

  async recordPipelineRun(run: PipelineRunRecord): Promise<void> {
    // Normalize like the D1 writer does (undefined -> NULL)
    this.runs.push({ ...run, error: run.error ?? null, id: this.runs.length + 1 });
  }

  async latestPipelineRuns(limit: number): Promise<PipelineRunRecord[]> {
    return [...this.runs]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }
}