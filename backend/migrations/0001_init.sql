-- The Anti-Spin Read — Cloudflare D1 schema (applied via wrangler d1 migrations apply)

CREATE TABLE IF NOT EXISTS articles (
  dedup_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  lede TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at);
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);

CREATE TABLE IF NOT EXISTS clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_phrase TEXT NOT NULL,
  seen_at INTEGER NOT NULL,          -- epoch ms
  framed_at INTEGER,                 -- epoch ms, NULL until framed
  framing_error TEXT,                -- set when Gemini fails
  framing TEXT                       -- JSON {headlineDeltas, toneTags, notableOmissions, neutralSummary}
);

CREATE INDEX IF NOT EXISTS idx_clusters_seen_at ON clusters(seen_at);
CREATE INDEX IF NOT EXISTS idx_clusters_framed_at ON clusters(framed_at);

CREATE TABLE IF NOT EXISTS cluster_articles (
  cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL REFERENCES articles(dedup_key),
  PRIMARY KEY (cluster_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_cluster_articles_dedup_key ON cluster_articles(dedup_key);