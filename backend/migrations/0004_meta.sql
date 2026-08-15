-- Maintenance state (key/value): last retention purge timestamp, etc.
-- Written by the Worker; read by the same. Keeps maintenance jobs
-- (purge, future chores) idempotent across runs without extra tables.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL -- epoch ms
);