-- Cluster signature (deterministic hash of sorted article keys) for
-- idempotent cluster creation, plus the single-row pipeline lock.

ALTER TABLE clusters ADD COLUMN sig TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clusters_sig ON clusters(sig);

CREATE TABLE IF NOT EXISTS pipeline_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  acquired_at INTEGER NOT NULL -- epoch ms; leases expire after 30 min
);