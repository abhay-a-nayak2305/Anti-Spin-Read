-- Add og:image URLs for articles (enriched post-clustering by the pipeline)

ALTER TABLE articles ADD COLUMN image_url TEXT NOT NULL DEFAULT '';