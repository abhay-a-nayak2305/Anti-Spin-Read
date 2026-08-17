-- Track the last og:image enrichment attempt per article so that
-- permanently-failing articles (publishers that 403 the Worker, or
-- redirect chains that never resolve) are not retried on every pipeline
-- run — which wasted the 50-subrequest budget that could serve articles
-- that CAN be enriched.
ALTER TABLE articles ADD COLUMN last_enrich_attempt_ms INTEGER NOT NULL DEFAULT 0;
